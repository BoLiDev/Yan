import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot } from '../helpers/fixtures.js';

/**
 * Phase 1 Trace, the two bullets that are the whole point of the strangler:
 *
 *   - "Interop: a bash `yan shift new` followed by a TS `yan ls` shows the
 *      shift correctly, and the reverse holds"
 *   - "`yan ls --json` output is byte-identical to the bash version for a
 *      fixture task"
 *
 * The interop boundary between the two halves is the file system (plan/INDEX.md
 * §2), so this test writes with one half and reads with the other, in both
 * directions, and then compares the two halves' own output byte for byte.
 */

afterAll(cleanupTempDirs);

let home = '';

function sh(
  args: readonly string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [...args], {
    encoding: 'utf8',
    env: { ...process.env, YAN_HOME: home, ...env },
    windowsHide: true,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `yan <args>` through the dispatcher — the ported half wherever one exists. */
function yan(args: readonly string[], env: Record<string, string> = {}) {
  return sh([join(home, 'bin', 'yan'), ...args], env);
}

/** The shell implementation, reached directly, so the two can be compared. */
function yanShell(script: string, args: readonly string[] = []) {
  return sh([join(home, 'bin', script), ...args]);
}

/** Run a snippet against the bash storage libraries. */
function bashLib(snippet: string) {
  return sh(['-c', `set -e; . "$YAN_HOME/bin/lib-task.sh"; ${snippet}`]);
}

beforeAll(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  for (const stub of ['lib-pool.sh', 'lib-term.sh', 'lib-forge.sh']) {
    cpSync(join(repoRoot, 'tests', 'stub', stub), join(home, 'bin', stub));
  }
  mkdirSync(join(home, 'repos', 'monorepo-x'), { recursive: true });

  // `yan sync` is a subcommand, not a seam, so it is replaced the same way the
  // bash suite replaces it: this one only records that it ran. Without it the
  // real sync would try to fetch a clone that is a bare directory here.
  writeFileSync(
    join(home, 'bin', 'yan-sync.sh'),
    '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n',
  );
  chmodSync(join(home, 'bin', 'yan-sync.sh'), 0o755);
});

describe('bash writes, TypeScript reads', () => {
  it('a bash yan shift new is shown correctly by a TS yan ls', () => {
    const seeded = bashLib(
      `task_init t042 'unify the auth header'; ` +
        `task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth --scope apps/common`,
    );
    expect(seeded.code, seeded.stderr).toBe(0);

    const tree = mkTempDir('yan-tree-');
    mkdirSync(join(tree, 'apps', 'auth'), { recursive: true });
    const calls = mkTempDir('yan-calls-');

    const dispatched = yan(['shift', 'new', '--task', 't042', '--unit', 'auth', '--sid', 's1', '--brief-text', 'parse the header'], {
      YAN_STUB_POOL_DIR: calls,
      YAN_STUB_TERM_DIR: calls,
      YAN_STUB_FORGE_DIR: calls,
      YAN_STUB_POOL_PATH: tree,
      YAN_STUB_POOL_LEASE_ID: 'lease-abc123',
    });
    expect(dispatched.code, `${dispatched.stdout}${dispatched.stderr}`).toBe(0);
    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's1', 'run', 'meta.json'))).toBe(true);

    // The TypeScript half, reading a file the shell half wrote.
    const ported = yan(['ls', 't042', '--json']);
    expect(ported.code, ported.stderr).toBe(0);
    const detail = JSON.parse(ported.stdout) as {
      id: string;
      shifts: Array<{ sid: string; unit: string; branch: string; tree: string }>;
    };
    expect(detail.id).toBe('t042');
    expect(detail.shifts).toHaveLength(1);
    expect(detail.shifts[0]?.sid).toBe('s1');
    expect(detail.shifts[0]?.unit).toBe('auth');
  });

  it('produces byte-identical --json for the same task', () => {
    const ported = yan(['ls', 't042', '--json']);
    const shell = yanShell('yan-ls.sh', ['t042', '--json']);
    expect(shell.code, shell.stderr).toBe(0);
    expect(ported.stdout).toBe(shell.stdout);

    const portedQueue = yan(['ls', '--json']);
    const shellQueue = yanShell('yan-ls.sh', ['--json']);
    expect(portedQueue.stdout).toBe(shellQueue.stdout);
  });

  it('renders the same human table', () => {
    // The only thing the two halves cannot spell identically is a PATH: the
    // shell half interpolates $YAN_HOME exactly as the caller wrote it, while
    // the ported half normalises to forward slashes (conventions §3). Both name
    // the same directory, so the comparison normalises before it compares.
    // Nothing in --json carries a path, which is why that one is byte-exact.
    //
    // `\\+` and not `\\`: the shell renderer pipes the shift rows through jq's
    // @tsv, which escapes a backslash as two, so a Windows tree path arrives in
    // the TREE column as `C:\\Users\\…`. The ported renderer prints the path it
    // was given. Both are the same path; only one of them is readable.
    const slashes = (s: string): string => s.replace(/\\+/g, '/');
    expect(slashes(yan(['ls']).stdout)).toBe(slashes(yanShell('yan-ls.sh').stdout));
    expect(slashes(yan(['ls', 't042']).stdout)).toBe(
      slashes(yanShell('yan-ls.sh', ['t042']).stdout),
    );
  });
});

describe('TypeScript writes, bash reads', () => {
  /** The TS store, driven in this process against the fixture home. */
  async function withStore<T>(fn: (store: typeof import('../../src/records/task/index.js')) => T): Promise<T> {
    const previous = process.env.YAN_HOME;
    process.env.YAN_HOME = home;
    try {
      return fn(await import('../../src/records/task/index.js'));
    } finally {
      if (previous === undefined) delete process.env.YAN_HOME;
      else process.env.YAN_HOME = previous;
    }
  }

  it('a task created by the TS store is shown correctly by the bash yan ls', async () => {
    await withStore((store) => {
      store.Task.create('t099', 'ported side writes');
      new store.Task('t099').addUnit('proto', 'monorepo-x', 'main', {
        branch: 'feat/proto',
        scope: ['apps/proto'],
        needs: ['auth'],
      });
      new store.Task('t099').unit('proto').appendHistory('feat/proto-r0', 'main', '08-01', 'delivered');
    });

    const shell = yanShell('yan-ls.sh', ['t099', '--json']);
    expect(shell.code, shell.stderr).toBe(0);
    const seen = JSON.parse(shell.stdout) as {
      title: string;
      units: Array<Record<string, unknown>>;
    };
    expect(seen.title).toBe('ported side writes');
    expect(seen.units[0]?.branch).toBe('feat/proto');
    expect(seen.units[0]?.needs).toEqual(['auth']);
    expect((seen.units[0]?.history as unknown[]).length).toBe(1);

    // …and both halves still print the same bytes for it.
    expect(yan(['ls', 't099', '--json']).stdout).toBe(shell.stdout);
  });

  it('writes the same bytes into task.json as the shell half would', async () => {
    // The same unit, built twice - once by each half - and compared on disk.
    // This is the assertion that keeps json.ts's two-space indent honest.
    const seeded = bashLib(
      `task_init tbash 'same bytes'; ` +
        `task_unit_add tbash auth monorepo-x master --branch feat/x --scope apps/auth --needs other`,
    );
    expect(seeded.code, seeded.stderr).toBe(0);

    await withStore((store) => {
      store.Task.create('tts', 'same bytes');
      new store.Task('tts').addUnit('auth', 'monorepo-x', 'master', {
        branch: 'feat/x',
        scope: ['apps/auth'],
        needs: ['other'],
      });
    });

    const fromBash = readFileSync(join(home, 'tasks', 'tbash', 'task.json'), 'utf8');
    const fromTs = readFileSync(join(home, 'tasks', 'tts', 'task.json'), 'utf8');
    expect(fromTs).toBe(fromBash.replace(/tbash/g, 'tts'));
  });
});
