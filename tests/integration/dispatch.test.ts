import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  cleanupTempDirs,
  mkTempDir,
  mkYanHome,
  repoRoot,
  runYan,
  type RunResult,
} from '../helpers/fixtures.js';

/**
 * `bin/yan`, which is a stub and nothing else: find `$YAN_HOME`, check git and
 * node, exec `dist/cli/yan.js`.
 *
 * It is shell, so it is tested by running it, from bash, in a throwaway
 * `$YAN_HOME` — and it stays shell because `$YAN_HOME/bin/yan` is the path in
 * `.claude/settings.json`, `.codex/hooks.json`, every shift's brief and
 * the instruction files. This file is what is meant by "the three stubs keep being
 * tested, from vitest": a whole bash framework is not needed to cover fifteen
 * lines.
 *
 * There is no per-command dispatch to test: the stub execs one file. A test
 * that conjures up a `bin/yan-fake.sh` to prove some fallback works would be
 * keeping a branch alive that nothing else has.
 */

afterAll(cleanupTempDirs);

/**
 * YAN_HOME is unset on purpose: the stub must resolve it from its own location,
 * which is how a copied fixture home stays self-contained. That is the whole
 * difference from `runYan`, and it is an argument rather than a second copy of
 * the helper — a local `spawnSync` here would block the worker exactly the way
 * `tests/helpers/fixtures.ts` explains at length.
 */
function yan(home: string, args: readonly string[]): Promise<RunResult> {
  return runYan(home, args, { YAN_HOME: undefined });
}

describe('in a tree that has never been built', () => {
  const home = mkYanHome(mkTempDir());

  it('refuses every invocation, loudly, and names the fix', async () => {
    // There is no half-migrated state left to be usable in, so the honest
    // answer to a missing dist/ is one sentence rather than a usage screen
    // listing nothing.
    for (const args of [[], ['--help'], ['ls'], ['bogus']]) {
      const r = await yan(home, args);
      expect(r.code, args.join(' ')).not.toBe(0);
      expect(r.out).toContain('npm run build');
    }
  });
});

describe('in a built tree', () => {
  const home = mkYanHome(mkTempDir(), { withDist: true });

  it('has a dist to exec into', () => {
    expect(existsSync(join(home, 'dist', 'cli', 'yan.js'))).toBe(true);
  });

  it('generates help from Commander, listing what is on disk', async () => {
    const r = await yan(home, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: yan');
    for (const name of ['doctor', 'ls', 'session-start', 'shift', 'wait']) {
      expect(r.out, name).toContain(name);
    }
  });

  it('reports a version', async () => {
    const r = await yan(home, ['--version']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('yan ');
  });

  it('exports YAN_HOME to the command, pointing at this home', async () => {
    const r = await yan(home, ['doctor']);
    // `doctor`'s first line is the home it resolved, which is the one thing
    // only the stub could have got wrong. Compared on the last segment: bash
    // says /tmp/yan-test-X and Node says C:\Users\…\Temp\yan-test-X, and that
    // gap is an msys *mount point*, which normalizePath() cannot close.
    expect(r.out).toContain(basename(home));
  });

  it('lists a command the moment its file appears, with no table to edit', async () => {
    const file = join(home, 'dist', 'cli', 'conjured.js');
    writeFileSync(
      file,
      [
        `import { Command } from 'commander';`,
        `export const command = new Command('conjured')`,
        `  .description('a command that exists because its file does')`,
        `  .action(() => { process.stdout.write('conjured-half\\n'); });`,
        '',
      ].join('\n'),
    );
    expect((await yan(home, ['--help'])).out).toContain('conjured');
    expect((await yan(home, ['conjured'])).out).toContain('conjured-half');

    rmSync(file);
    expect((await yan(home, ['--help'])).out).not.toContain('conjured');
    expect((await yan(home, ['conjured'])).code).toBe(2);
  });

  it('reaches a two-word command by either spelling', async () => {
    // `yan shift new` and `yan shift-new` are the same place. Commander cannot
    // see two words as one name, so the rewrite happens once before parsing —
    // and only when the hyphenated name exists, so `yan ls t042` is untouched.
    mkdirSync(join(home, 'tasks'), { recursive: true });
    expect((await yan(home, ['shift', 'new', '--help'])).out).toContain('dispatch a shift');
    expect((await yan(home, ['unit', 'add', '--help'])).out).toContain('--target');
  });
});

describe('the inline dependency check', () => {
  const source = readFileSync(join(repoRoot, 'bin', 'yan'), 'utf8');

  it('asks for git and node, and no longer for jq', () => {
    const line = /for _yan_dep in ([^;]+); do/.exec(source);
    expect(line).not.toBeNull();
    const deps = (line?.[1] ?? '').trim().split(/\s+/);
    expect(deps).toEqual(['git', 'node']);
  });

  it('keeps no central list of subcommands, and no shell half to fall back to', () => {
    expect(/^[ \t]*(doctor|repo-add|shift)\)/m.test(source)).toBe(false);
    // Prose may still explain what went; code may not reach for it.
    const code = source.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toContain('yan-');
  });

  it('is short enough to read in one sitting', () => {
    // A further words: "each is a few lines". The number is not sacred; a
    // stub that has grown back into a dispatcher is what this notices.
    const code = source
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    expect(code.length).toBeLessThan(45);
  });
});
