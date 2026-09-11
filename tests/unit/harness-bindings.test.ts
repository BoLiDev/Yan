import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/fixtures.js';

/**
 * What each harness is actually told to run.
 *
 *   Claude   SessionStart → `yan session-start`
 *            Stop         → hook-autoarm.sh, asyncRewake, a long timeout
 *            Stop         → hook-turnend-guard.sh --claude, blocking
 *   Codex    SessionStart → `yan session-start`
 *            Stop         → the turn-end guard, --codex
 *            and no autoarm: Codex parses `async` but does not run asynchronous
 *            command hooks, so it cannot hold a multi-hour watcher
 *   Agy      PreInvocation → the session-start stand-in, once per conversation
 *            Stop          → the autoarm, then the turn-end guard, --agy
 *            in agy's own file shape, which is not the other two's
 *
 * The codex half asserts the shape codex parses — the nesting, the
 * string-valued `command`, `timeout` in seconds, and the absence of the keys
 * it rejects — because a grep over the body passes on a file codex refuses to
 * read at all.
 */

function settings(...parts: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, ...parts), 'utf8')) as Record<string, unknown>;
}

interface HookEntry {
  type?: string;
  command?: unknown;
  timeout?: number;
  asyncRewake?: boolean;
  timeout_ms?: number;
}

/** event → the flat list of hook entries registered for it. */
function hooksFor(doc: Record<string, unknown>, event: string): HookEntry[] {
  const hooks = (doc.hooks ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks[event]) ? (hooks[event] as Record<string, unknown>[]) : [];
  return groups.flatMap((g) => (Array.isArray(g.hooks) ? (g.hooks as HookEntry[]) : []));
}

const claude = settings('.claude', 'settings.json');
const codex = settings('.codex', 'hooks.json');

describe('Claude', () => {
  it('nudges the rebuild on SessionStart, and does not wait there', () => {
    const start = hooksFor(claude, 'SessionStart');
    expect(start).toHaveLength(1);
    expect(String(start[0]?.command)).toContain('session-start');
    // SessionStart is seconds-scale. Arming a watcher there would hold the
    // session's first turn open for hours.
    expect(String(start[0]?.command)).not.toContain('wait');
  });

  it('registers exactly two Stop hooks: the async watcher and the blocking guard', () => {
    const stop = hooksFor(claude, 'Stop');
    expect(stop).toHaveLength(2);

    const autoarm = stop.find((h) => String(h.command).includes('hook-autoarm'));
    expect(autoarm?.asyncRewake).toBe(true);
    // Eight hours is the workable default: the watcher runs in this hook's
    // foreground for as long as the shifts do.
    expect(autoarm?.timeout ?? 0).toBeGreaterThanOrEqual(28800);

    const guard = stop.find((h) => String(h.command).includes('hook-turnend-guard'));
    expect(String(guard?.command)).toContain('--claude');
    expect(guard?.asyncRewake, 'the guard blocks; it is not an async hook').toBeUndefined();
  });
});

describe('Codex: the shape codex parses', () => {
  it('carries none of the three keys codex refuses the whole file for', () => {
    // Each of these is the sort of thing a grep over the body cannot see.
    expect(codex.version, 'a top-level `version` is what codex refused').toBeUndefined();

    const every = [...hooksFor(codex, 'SessionStart'), ...hooksFor(codex, 'Stop')];
    for (const hook of every) {
      expect(hook.timeout_ms, '`timeout` in seconds, never `timeout_ms`').toBeUndefined();
      expect(typeof hook.command, '`command` is a string; an array is refused').toBe('string');
    }
  });

  it('has the matcher-group nesting level Claude also has', () => {
    const hooks = codex.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
    expect(hooksFor(codex, 'SessionStart')).toHaveLength(1);
    expect(hooksFor(codex, 'Stop'), 'one Stop hook — the guard, and no autoarm').toHaveLength(1);
  });
});

describe('Codex: what those hooks run', () => {
  const start = hooksFor(codex, 'SessionStart')[0];
  const stop = hooksFor(codex, 'Stop')[0];

  it('is the rebuild and the guard, at seconds-scale timeouts', () => {
    for (const hook of [start, stop]) {
      expect(hook?.type).toBe('command');
      const t = hook?.timeout ?? 0;
      expect(t, 'a number of SECONDS has to look like one').toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(3600);
    }
    expect(String(start?.command)).toContain('session-start');
    expect(String(start?.command)).not.toContain('wait');
    expect(String(stop?.command)).toContain('turnend-guard');
    expect(String(stop?.command)).toContain('--codex');
  });

  it('starts the interpreter directly, because the shell it would get is not knowable', () => {
    // Codex hands the command string to the platform shell, which on Windows
    // is PowerShell: there `bash` resolves to the WSL launcher and `sh` to
    // nothing at all.
    for (const hook of [start, stop]) {
      const command = String(hook?.command);
      expect(command.startsWith('node ')).toBe(true);
      expect(command, 'no shell expansion: PowerShell would eat it').not.toContain('$');
      expect(command, 'no cmd.exe expansion either').not.toContain('%');
      // cwd is the project root, which is what `yan continue` starts the main
      // agent in — and the main agent is the only codex this file ever reaches.
      expect(command).toContain('./dist/');
    }
  });

  it('registers no autoarm and no checkpoint hook', () => {
    const body = readFileSync(join(repoRoot, '.codex', 'hooks.json'), 'utf8');
    expect(body, 'Codex cannot hold a multi-hour watcher').not.toContain('hook-autoarm');
    expect(body).not.toContain('asyncRewake');
    expect(body, 'the Codex checkpoint loop is the model, not a hook').not.toContain('yan wait');
  });
});

/**
 * Agy's file is a different shape from the other two: the top level is named
 * hooks rather than an event map, and a lifecycle event holds its handlers
 * directly — there is no matcher-group level, because only the tool-use pair
 * takes a matcher.
 */
describe('Agy: the shape agy parses', () => {
  const agy = settings('.agents', 'hooks.json');

  /** event → the handlers registered for it, across every named hook. */
  function handlers(event: string): HookEntry[] {
    return Object.values(agy).flatMap((named) => {
      const events = (named ?? {}) as Record<string, unknown>;
      return Array.isArray(events[event]) ? (events[event] as HookEntry[]) : [];
    });
  }

  it('has no event map and no matcher-group level', () => {
    expect(agy.hooks, 'the other two nest under `hooks`; agy names its hooks').toBeUndefined();
    for (const named of Object.values(agy)) {
      for (const list of Object.values(named as Record<string, unknown>)) {
        for (const entry of list as Record<string, unknown>[]) {
          expect(entry.hooks, 'a lifecycle handler, not a matcher group').toBeUndefined();
          expect(entry.matcher, 'only PreToolUse and PostToolUse take a matcher').toBeUndefined();
          expect(typeof entry.command).toBe('string');
        }
      }
    }
  });

  it('rebuilds the picture before the first model call, since agy has no SessionStart', () => {
    const pre = handlers('PreInvocation');
    expect(pre).toHaveLength(1);
    expect(String(pre[0]?.command)).toContain('session-start');
    // Injecting the report is seconds-scale; arming a watcher here would hold
    // every model call open for hours.
    expect(String(pre[0]?.command)).not.toContain('wait');
    expect(pre[0]?.timeout ?? 0).toBeLessThanOrEqual(300);
  });

  it('registers the watcher and the guard on Stop, in that order', () => {
    const stop = handlers('Stop');
    expect(stop).toHaveLength(2);
    // Handlers run in declaration order and any `continue` wins, so the long
    // watcher has to be the one that runs first: the guard is what notices an
    // autoarm that did not arm anything.
    expect(String(stop[0]?.command)).toContain('autoarm');
    expect(String(stop[1]?.command)).toContain('turnend-guard');
    for (const hook of stop) expect(String(hook.command)).toContain('--agy');

    // Agy's Stop hook blocks its loop synchronously, so the watcher's whole
    // run has to fit inside the timeout the way Claude's eight hours do.
    expect(stop[0]?.timeout ?? 0).toBeGreaterThanOrEqual(28800);
    expect(stop[1]?.timeout ?? 0).toBeLessThanOrEqual(300);
  });

  it('starts the interpreter directly, relative to the file agy runs it from', () => {
    // Agy runs a hook via `cmd /c` on Windows with cwd set to the directory
    // holding hooks.json — so `.agents/`, one below the project root. Relative
    // is not a stylistic choice: a Windows path through that shell is a
    // minefield either way round, because unquoted backslashes are eaten and a
    // quoted path arrives with its quotes still attached. Herdr's own agy
    // integration ships the quoted form and fails on every invocation for
    // exactly that reason.
    for (const hook of [...handlers('PreInvocation'), ...handlers('Stop')]) {
      const command = String(hook.command);
      expect(command.startsWith('node ')).toBe(true);
      expect(command).toContain('../dist/');
      expect(command, 'no shell expansion: PowerShell would eat it').not.toContain('$');
      expect(command, 'no cmd.exe expansion either').not.toContain('%');
      expect(command, 'no absolute path, and so no backslash and no quoting').not.toContain('\\');
      expect(command, 'a relative path needs no quotes').not.toContain('"');
      expect(hook.type).toBe('command');
    }
  });
});
