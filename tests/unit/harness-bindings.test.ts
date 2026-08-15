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
