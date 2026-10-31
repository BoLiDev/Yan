import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Every function of the module, each with what it needs besides the directory.
const inADirectory: Array<[string, (dir: string) => unknown]> = [
  ['git', (d) => g.git(d, ['status'])],
  ['gitOk', (d) => g.gitOk(d, ['status'])],
  ['currentBranch', (d) => g.currentBranch(d)],
  ['branchOf', (d) => g.branchOf(d)],
  ['upstreamOf', (d) => g.upstreamOf(d, 'main')],
  ['branchExists', (d) => g.branchExists(d, 'x')],
  ['statusPorcelain', (d) => g.statusPorcelain(d)],
  ['treeStatus', (d) => g.treeStatus(d)],
  ['isClean', (d) => g.isClean(d)],
  ['revParse', (d) => g.revParse(d, ['HEAD'])],
  ['defaultBranch', (d) => g.defaultBranch(d)],
  ['headOnRemote', (d) => g.headOnRemote(d)],
  ['commitCount', (d) => g.commitCount(d, ['HEAD'])],
  ['fetch', (d) => g.fetch(d)],
  ['fetchAsync', (d) => g.fetchAsync(d)],
  ['checkout', (d) => g.checkout(d, ['main'])],
  ['detach', (d) => g.detach(d)],
  ['rebase', (d) => g.rebase(d, ['main'])],
  ['worktreeAdd', (d) => g.worktreeAdd(d, ['p'])],
  ['worktreeList', (d) => g.worktreeList(d)],
  ['worktreePrune', (d) => g.worktreePrune(d)],
  ['resetHard', (d) => g.resetHard(d)],
  ['cleanFd', (d) => g.cleanFd(d)],
  ['cloneRepo', (d) => g.cloneRepo(d, 'u', 'n')],
  ['remoteUrl', (d) => g.remoteUrl(d)],
];

/** The code of the YanError `call` refuses with, thrown or rejected; undefined when it goes ahead. */
async function refusal(call: () => unknown): Promise<string | undefined> {
  try {
    await call();
  } catch (e) {
    return e instanceof YanError ? e.code : `not a YanError: ${String(e)}`;
  }
  return undefined;
}

/** What each function in the table refuses `dir` with, by name. */
async function refusals(dir: string): Promise<Record<string, string | undefined>> {
  return Object.fromEntries(await Promise.all(inADirectory.map(async ([name, call]) => [name, await refusal(() => call(dir))] as const)));
}

const everyOne = (code: string): Record<string, string> => Object.fromEntries(inADirectory.map(([name]) => [name, code]));

describe('the explicit-directory invariant', () => {
  // Were a guard to give way, git would run wherever the process is: let that be an empty folder rather than
  // this checkout, where a `reset --hard` or a `clean -fd` would take uncommitted work with it.
  let was = '';
  beforeAll(() => {
    was = process.cwd();
    process.chdir(mkTempDir());
  });
  afterAll(() => process.chdir(was));

  it('refuses an empty directory everywhere, rather than running git wherever the process is', async () => {
    expect(await refusals('')).toEqual(everyOne('git_usage'));
  });

  it('refuses a directory that does not exist everywhere', async () => {
    expect(await refusals(join(mkTempDir(), 'definitely-not-a-directory'))).toEqual(everyOne('git_usage'));
  });
});

describe('required arguments beyond the directory', () => {
  // Only where a missing argument would otherwise be answered rather than
  // refused: git's own error is the guard everywhere else.
  it('refuses what git would silently accept', async () => {
    const tmp = mkTempDir();
    expect(await refusal(() => g.branchExists(tmp, ''))).toBe('git_usage');
    expect(await refusal(() => g.upstreamOf(tmp, ''))).toBe('git_usage');
    expect(await refusal(() => g.checkout(tmp, []))).toBe('git_usage');
    expect(await refusal(() => g.rebase(tmp, []))).toBe('git_usage');
    expect(await refusal(() => g.revParse(tmp, []))).toBe('git_usage');
    expect(await refusal(() => g.cloneRepo(tmp, '', 'n'))).toBe('git_usage');
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
