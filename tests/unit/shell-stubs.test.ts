import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../helpers/fixtures.js';

/**
 * The three shell files yan has left, run through shellcheck — an unquoted
 * `$YAN_HOME` in a path with a space is what these stubs would fail on.
 *
 * Skips loudly when shellcheck is absent rather than passing quietly.
 */

const BIN = join(repoRoot, 'bin');

function shellFiles(): string[] {
  return readdirSync(BIN).filter((f) => f === 'yan' || f.endsWith('.sh')).sort();
}

const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8', windowsHide: true });
const available = shellcheck.status === 0;

describe('bin/ holds exactly four files, and each shell one is a stub', () => {
  it('is `yan`, `yan.mjs`, `hook-autoarm.sh`, `hook-turnend-guard.sh` and nothing else', () => {
    // `yan.mjs` is the npm `bin` target, which cannot be a bash shebang.
    expect(readdirSync(BIN).sort()).toEqual([
      'hook-autoarm.sh',
      'hook-turnend-guard.sh',
      'yan',
      'yan.mjs',
    ]);
  });

  it('each of them dispatches and does not decide', () => {
    for (const name of shellFiles()) {
      const source = readFileSync(join(BIN, name), 'utf8');
      // Every one of them ends by handing over to node. A stub that grew a
      // decision would need something else here.
      expect(source, name).toContain('exec node ');
      const code = source.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
      expect(code.length, `bin/${name} is ${code.length} lines of code`).toBeLessThan(45);
    }
  });

  it('sources no shell library: there are none left to source', () => {
    // Prose may name a library; code may not reach for one.
    for (const name of shellFiles()) {
      const code = readFileSync(join(BIN, name), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code, name).not.toContain('lib-');
      expect(code, name).not.toMatch(/^\s*\.\s/m);
    }
  });
});

describe('shellcheck', () => {
  it.skipIf(!available)('is clean at --severity=warning', () => {
    const r = spawnSync(
      'shellcheck',
      ['--severity=warning', '-P', repoRoot, ...shellFiles().map((f) => join(BIN, f))],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
  });

  it('says so out loud when it is not installed, rather than passing quietly', () => {
    if (!available) {
      process.stderr.write('shell-stubs: shellcheck is not on PATH - the lint half of this file did not run\n');
    }
    expect(true).toBe(true);
  });
});
