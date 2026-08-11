import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot } from '../helpers/fixtures.js';

/**
 * `bin/yan`, which since Phase 9 is a stub and nothing else: find `$YAN_HOME`,
 * check git and node, exec `dist/cli/yan.js`.
 *
 * It is shell, so it is tested by running it, from bash, in a throwaway
 * `$YAN_HOME` — and it stays shell because `$YAN_HOME/bin/yan` is the path in
 * `.claude/settings.json`, `.codex/hooks.json`, every shift's brief and
 * `AGENTS.md`. This file is what Phase 9 meant by "the three stubs keep being
 * tested, from vitest": a whole bash framework is not needed to cover fifteen
 * lines.
 *
 * WHAT WENT, AND WHY THE TESTS FOR IT WENT WITH IT. `bin/yan` used to prefer
 * `dist/cli/<cmd>.js` and fall back to `bin/yan-<cmd>.sh`, both derived from a
 * glob. That was the strangler (plan/INDEX.md §2) and Phase 8 removed the last
 * shell command, so the fallback branch could only ever find nothing. A test
 * that conjures up a `bin/yan-fake.sh` to prove the fallback still works is a
 * test that keeps a dead branch alive.
 */

afterAll(cleanupTempDirs);

function yan(home: string, args: readonly string[]): { code: number; out: string } {
  // YAN_HOME is unset on purpose: the stub must resolve it from its own
  // location, which is how a copied fixture home stays self-contained.
  const env = { ...process.env };
  delete env.YAN_HOME;
  const r = spawnSync('bash', [join(home, 'bin', 'yan'), ...args], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('in a tree that has never been built', () => {
  const home = mkYanHome(mkTempDir());

  it('refuses every invocation, loudly, and names the fix', () => {
    // There is no half-migrated state left to be usable in, so the honest
    // answer to a missing dist/ is one sentence rather than a usage screen
    // listing nothing.
    for (const args of [[], ['--help'], ['ls'], ['bogus']]) {
      const r = yan(home, args);
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

  it('generates help from Commander, listing what is on disk', () => {
    const r = yan(home, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: yan');
    for (const name of ['doctor', 'ls', 'session-start', 'shift', 'wait']) {
      expect(r.out, name).toContain(name);
    }
  });

  it('reports a version', () => {
    const r = yan(home, ['--version']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('yan ');
  });

  it('exports YAN_HOME to the command, pointing at this home', () => {
    const r = yan(home, ['doctor']);
    // `doctor`'s first line is the home it resolved, which is the one thing
    // only the stub could have got wrong. Compared on the last segment: bash
    // says /tmp/yan-test-X and Node says C:\Users\…\Temp\yan-test-X, and that
    // gap is an MSYS *mount point*, which normalizePath() cannot close.
    expect(r.out).toContain(basename(home));
  });

  it('lists a command the moment its file appears, with no table to edit', () => {
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
    expect(yan(home, ['--help']).out).toContain('conjured');
    expect(yan(home, ['conjured']).out).toContain('conjured-half');

    rmSync(file);
    expect(yan(home, ['--help']).out).not.toContain('conjured');
    expect(yan(home, ['conjured']).code).toBe(2);
  });

  it('reaches a two-word command by either spelling', () => {
    // `yan shift new` and `yan shift-new` are the same place. Commander cannot
    // see two words as one name, so the rewrite happens once before parsing —
    // and only when the hyphenated name exists, so `yan ls t042` is untouched.
    mkdirSync(join(home, 'tasks'), { recursive: true });
    expect(yan(home, ['shift', 'new', '--help']).out).toContain('dispatch a shift');
    expect(yan(home, ['unit', 'add', '--help']).out).toContain('--target');
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
    // Phase 9's own words: "each is a few lines". The number is not sacred; a
    // stub that has grown back into a dispatcher is what this notices.
    const code = source
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    expect(code.length).toBeLessThan(45);
  });
});
