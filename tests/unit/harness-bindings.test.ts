import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/fixtures.js';

/**
 * What each harness is actually told to run — one hook each, and nothing at
 * the end of a turn:
 *
 *   Claude   SessionStart  → `yan session-start`
 *   Codex    SessionStart  → `yan session-start`
 *   Agy      PreInvocation → the session-start stand-in, once per conversation
 *                            in agy's own file shape, which is not the other
 *                            two's
 *
 * A shift says what happened with `yan report`, which types the line into the
 * main agent's pane, so nothing has to be armed when a turn ends.
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
  it('nudges the rebuild on SessionStart, at a seconds-scale timeout', () => {
    const start = hooksFor(claude, 'SessionStart');
    expect(start).toHaveLength(1);
    expect(String(start[0]?.command)).toContain('session-start');
    expect(start[0]?.timeout ?? 0).toBeLessThanOrEqual(300);
  });

  it('registers nothing at the end of a turn', () => {
    expect(hooksFor(claude, 'Stop')).toHaveLength(0);
    const body = readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8');
    expect(body, 'a shift reports; nothing has to be armed to hear it').not.toContain('Stop');
    expect(body).not.toContain('asyncRewake');
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
    expect(hooks.Stop, 'nothing runs at the end of a turn').toBeUndefined();
    expect(hooksFor(codex, 'SessionStart')).toHaveLength(1);
  });
});

describe('Codex: what that hook runs', () => {
  const start = hooksFor(codex, 'SessionStart')[0];

  it('is the rebuild, at a seconds-scale timeout', () => {
    expect(start?.type).toBe('command');
    const t = start?.timeout ?? 0;
    expect(t, 'a number of SECONDS has to look like one').toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(3600);
    expect(String(start?.command)).toContain('session-start');
  });

  it('starts the interpreter directly, because the shell it would get is not knowable', () => {
    // Codex hands the command string to the platform shell, which on Windows
    // is PowerShell: there `bash` resolves to the WSL launcher and `sh` to
    // nothing at all.
    const command = String(start?.command);
    expect(command.startsWith('node ')).toBe(true);
    expect(command, 'no shell expansion: PowerShell would eat it').not.toContain('$');
    expect(command, 'no cmd.exe expansion either').not.toContain('%');
    // cwd is the project root, which is what `yan continue` starts the main
    // agent in — and the main agent is the only codex this file ever reaches.
    expect(command).toContain('./dist/');
  });

  it('registers nothing at the end of a turn', () => {
    const body = readFileSync(join(repoRoot, '.codex', 'hooks.json'), 'utf8');
    expect(body, 'a shift reports; nothing has to be armed to hear it').not.toContain('Stop');
    expect(body).not.toContain('asyncRewake');
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
    // Injecting the report is seconds-scale, and it runs before every model
    // call: anything long here would hold each one open.
    expect(pre[0]?.timeout ?? 0).toBeLessThanOrEqual(300);
  });

  it('registers nothing at the end of a turn', () => {
    expect(handlers('Stop')).toHaveLength(0);
    const body = readFileSync(join(repoRoot, '.agents', 'hooks.json'), 'utf8');
    expect(body, 'a shift reports; nothing has to be armed to hear it').not.toContain('Stop');
  });

  it('starts the interpreter directly, relative to the file agy runs it from', () => {
    // Agy runs a hook via `cmd /c` on Windows with cwd set to the directory
    // holding hooks.json — so `.agents/`, one below the project root. Relative
    // is not a stylistic choice: a Windows path through that shell is a
    // minefield either way round, because unquoted backslashes are eaten and a
    // quoted path arrives with its quotes still attached. Herdr's own agy
    // integration ships the quoted form and fails on every invocation for
    // exactly that reason.
    for (const hook of handlers('PreInvocation')) {
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
