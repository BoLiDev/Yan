import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as g from './git.js';
import { cleanupTempDirs, fxGit, mkTempDir } from '../../tests/helpers/fixtures.js';
import { YanError } from './error.js';

/**
 * `util/git.ts` refuses to run without an explicit directory, and asks
 * rather than assumes which branch is the default.
 */

afterAll(cleanupTempDirs);

// Every function whose first argument is a directory, listed explicitly: one
// that forgets the guard shows up as a missing name here.
const directoryFirst: Array<[string, (dir: string) => unknown]> = [
  ['currentBranch', (d) => g.currentBranch(d)],
  ['branchExists', (d) => g.branchExists(d, 'x')],
  ['fetch', (d) => g.fetch(d)],
  ['checkout', (d) => g.checkout(d, ['main'])],
  ['statusPorcelain', (d) => g.statusPorcelain(d)],
  ['treeStatus', (d) => g.treeStatus(d)],
  ['isClean', (d) => g.isClean(d)],
  ['rebase', (d) => g.rebase(d, ['main'])],
  ['worktreeAdd', (d) => g.worktreeAdd(d, ['p'])],
  ['worktreeList', (d) => g.worktreeList(d)],
  ['worktreePrune', (d) => g.worktreePrune(d)],
  ['resetHard', (d) => g.resetHard(d)],
  ['cleanFd', (d) => g.cleanFd(d)],
  ['headOnRemote', (d) => g.headOnRemote(d)],
  ['revParse', (d) => g.revParse(d, ['HEAD'])],
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
    expect(thrown).toBeInstanceOf(YanError);
    expect((thrown as YanError).code).toBe('git_usage');
    expect((thrown as YanError).message).toContain('a directory argument is required');
    expect((thrown as YanError).message).toContain('never uses the current working directory');
  });

  it.each(directoryFirst)('%s refuses a directory that does not exist', (_name, call) => {
    const missing = join(mkTempDir(), 'definitely-not-a-directory');
    let thrown: unknown;
    try {
      call(missing);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(YanError);
    expect((thrown as YanError).message).toContain('not a directory');
  });
});

describe('required arguments beyond the directory', () => {
  // Only where a missing argument would otherwise be answered rather than
  // refused: git's own error is the guard everywhere else.
  it('refuses what git would silently accept', () => {
    const tmp = mkTempDir();
    expect(() => g.branchExists(tmp, '')).toThrow(YanError);
    expect(() => g.checkout(tmp, [])).toThrow(YanError);
    expect(() => g.rebase(tmp, [])).toThrow(YanError);
    expect(() => g.revParse(tmp, [])).toThrow(YanError);
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
