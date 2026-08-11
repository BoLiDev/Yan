import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as g from '../../src/util/git.js';
import { GitError } from '../../src/util/git.js';
import { cleanupTempDirs, mkTempDir, repoRoot } from '../helpers/fixtures.js';

/**
 * The port of `tests/unit/lib-git-contract.test.sh`.
 *
 * Phase 0 Trace: "util/git.ts refuses to run without an explicit directory and
 * never uses --force."
 */

afterAll(cleanupTempDirs);

// Every function whose first argument is a directory. The bash file lists the
// same set; keeping it explicit is the point — a new function that forgets the
// guard shows up as a missing name here.
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

describe('no force flag anywhere in src/', () => {
  // boundaries.md §9.2 lists force-pushing and forced tree destruction as
  // forbidden. This is a source-level check on purpose: a runtime test can only
  // cover the paths it happens to exercise.
  function allSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...allSources(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('src/ contains no force flag', () => {
    const offenders = allSources(join(repoRoot, 'src')).filter((f) =>
      readFileSync(f, 'utf8').includes(`--${'force'}`),
    );
    expect(offenders).toEqual([]);
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
