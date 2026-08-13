import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as g from '../../src/util/git.js';
import { GitError } from '../../src/util/git.js';
import { cleanupTempDirs, fxGit, mkTempDir, repoRoot } from '../helpers/fixtures.js';

/**
 * `util/git.ts` refuses to run without an explicit directory, and never
 * force-pushes.
 */

afterAll(cleanupTempDirs);

// Every function whose first argument is a directory, listed explicitly: one
// that forgets the guard shows up as a missing name here.
const directoryFirst: Array<[string, (dir: string) => unknown]> = [
  ['currentBranch', (d) => g.currentBranch(d)],
  ['branchExists', (d) => g.branchExists(d, 'x')],
  ['remoteBranchExists', (d) => g.remoteBranchExists(d, 'x')],
  ['fetch', (d) => g.fetch(d)],
  ['checkout', (d) => g.checkout(d, ['main'])],
  ['createBranch', (d) => g.createBranch(d, 'a', 'b')],
  ['statusPorcelain', (d) => g.statusPorcelain(d)],
  ['isClean', (d) => g.isClean(d)],
  ['push', (d) => g.push(d)],
  ['deleteRemoteBranch', (d) => g.deleteRemoteBranch(d, 'origin', 'x')],
  ['rebase', (d) => g.rebase(d, ['main'])],
  ['merge', (d) => g.merge(d, ['main'])],
  ['worktreeAdd', (d) => g.worktreeAdd(d, ['p'])],
  ['worktreeRemove', (d) => g.worktreeRemove(d, ['p'])],
  ['worktreeList', (d) => g.worktreeList(d)],
  ['worktreePrune', (d) => g.worktreePrune(d)],
  ['resetHard', (d) => g.resetHard(d)],
  ['cleanFd', (d) => g.cleanFd(d)],
  ['branchesContainingHead', (d) => g.branchesContainingHead(d)],
  ['diffNameOnly', (d) => g.diffNameOnly(d)],
  ['revParse', (d) => g.revParse(d, ['HEAD'])],
  ['clone', (d) => g.clone(d, 'https://example.invalid/x.git', 'dest')],
  ['remoteUrl', (d) => g.remoteUrl(d)],
];

describe('the explicit-directory invariant', () => {
  it.each(directoryFirst)('%s refuses an empty directory', (_name, call) => {
    let thrown: unknown;
    try {
      call('');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GitError);
    expect((thrown as GitError).code).toBe(g.GitError.codes.usage);
    expect((thrown as GitError).message).toContain('a directory argument is required');
    expect((thrown as GitError).message).toContain('never uses the current working directory');
  });

  it.each(directoryFirst)('%s refuses a directory that does not exist', (_name, call) => {
    const missing = join(mkTempDir(), 'definitely-not-a-directory');
    let thrown: unknown;
    try {
      call(missing);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GitError);
    expect((thrown as GitError).message).toContain('not a directory');
  });
});

describe('required arguments beyond the directory', () => {
  it('refuses the ones the shell version refuses', () => {
    const tmp = mkTempDir();
    expect(() => g.branchExists(tmp, '')).toThrow(GitError);
    expect(() => g.createBranch(tmp, 'newbranch', '')).toThrow(GitError);
    expect(() => g.deleteRemoteBranch(tmp, 'origin', '')).toThrow(GitError);
    expect(() => g.worktreeAdd(tmp, [])).toThrow(GitError);
    expect(() => g.clone(tmp, 'https://example.invalid/x.git', '')).toThrow(GitError);
    expect(() => g.revParse(tmp, [])).toThrow(GitError);
  });
});

describe('no force flag ever reaches git', () => {
  // A source-level check, because a runtime one covers only the paths it
  // happens to exercise. It is narrowed to what can actually reach git: a
  // quoted force literal in an argument list. Prose may name the flag, and
  // `yan done --force` is a Commander option rather than a git argument.
  function allSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...allSources(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const FORCE = `--${'force'}`;

  it('util/git.ts, the only module that spawns git, does not name it at all', () => {
    expect(readFileSync(join(repoRoot, 'src', 'util', 'git.ts'), 'utf8')).not.toContain(FORCE);
  });

  it('no quoted force literal appears in src/, except yan done\'s own option', () => {
    // A whole quoted token — `'--force'`, `'--force-with-lease'`, `'--force=x'`
    // — is what an argument list holds. `--force:` inside a sentence is not one.
    const quoted = new RegExp(`(['"\`])${FORCE}(-with-lease|=[^'"\`]*)?\\1`);
    const offenders = allSources(join(repoRoot, 'src')).filter((f) => {
      // Comments may name what is forbidden; code may not run it.
      let code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // `yan done` declares the flag; that declaration is the authority, and
      // Commander is not git.
      if (f.endsWith(`cli${sep}done.ts`)) code = code.replace(/\.option\([^)]*\)/g, '');
      return quoted.test(code);
    });
    expect(offenders, 'a force flag in an argument list is a force flag reaching git').toEqual([]);
  });

  it('git clean is -fd and never -x', () => {
    const source = readFileSync(join(repoRoot, 'src', 'util', 'git.ts'), 'utf8');
    expect(source).toContain(`'clean', '-fd'`);
    expect(/'clean',\s*'-[a-zA-Z]*x/.test(source)).toBe(false);
  });
});

describe('push actively refuses a force flag handed to it', () => {
  it.each([['-f'], [`--${'force'}`], [`--${'force'}-with-lease`], [`--${'force'}=x`]])(
    'refuses %s',
    (flag) => {
      const tmp = mkTempDir();
      let thrown: unknown;
      try {
        g.push(tmp, ['origin', 'main', flag]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(GitError);
      expect((thrown as GitError).code).toBe(g.GitError.codes.forceRefused);
      expect((thrown as GitError).message).toContain('refusing to force-push');
    },
  );

  it('lets an ordinary push through the guard', () => {
    // The guard must not be a blanket refusal: an ordinary push reaches git,
    // which then fails for its own reasons in an empty directory.
    const tmp = mkTempDir();
    expect(g.push(tmp, ['origin', 'main']).code).not.toBe(0);
  });
});

describe('the default branch is asked for, never assumed', () => {
  it('reads what the clone already knows, without touching the network', async () => {
    // Deliberately neither main nor master: a detection that works only for
    // the two names everyone hardcodes has detected nothing.
    const bare = join(mkTempDir(), 'origin.git');
    await fxGit(['init', '--bare', '--initial-branch=release/24.10', bare]);

    const seed = mkTempDir('yan-seed-');
    await fxGit(['init', '--initial-branch=release/24.10', '.'], seed);
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    await fxGit(['add', '.'], seed);
    await fxGit(['commit', '-m', 'initial'], seed);
    await fxGit(['remote', 'add', 'origin', bare], seed);
    await fxGit(['push', '-u', 'origin', 'release/24.10'], seed);

    const clone = join(mkTempDir(), 'clone');
    await fxGit(['clone', bare, clone]);
    expect(g.defaultBranch(clone)).toBe('release/24.10');
  });

  it('falls back to asking the remote when the clone has no origin/HEAD', async () => {
    const bare = join(mkTempDir(), 'origin.git');
    await fxGit(['init', '--bare', '--initial-branch=trunk', bare]);
    const seed = mkTempDir('yan-seed-');
    await fxGit(['init', '--initial-branch=trunk', '.'], seed);
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    await fxGit(['add', '.'], seed);
    await fxGit(['commit', '-m', 'initial'], seed);
    await fxGit(['remote', 'add', 'origin', bare], seed);
    await fxGit(['push', '-u', 'origin', 'trunk'], seed);

    const clone = join(mkTempDir(), 'clone');
    await fxGit(['clone', bare, clone]);
    // Exactly the state a --single-branch clone or a hand-added remote leaves.
    await fxGit(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], clone);
    expect(g.defaultBranch(clone)).toBe('trunk');
  });

  it('says it does not know rather than picking something', async () => {
    // No remote at all: `undefined` is an answer, not a failure.
    const lonely = mkTempDir();
    await fxGit(['init', '--initial-branch=main', '.'], lonely);
    expect(g.defaultBranch(lonely)).toBeUndefined();
  });
});
