import { copyFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcessAsync } from '../../util/process.js';
import { gitAsync } from './blobs.js';

/**
 * A worktree as it stands, as a commit: its HEAD when nothing in it is
 * uncommitted, else a commit made of everything in it, changed, staged and
 * new alike, less what git ignores, with HEAD as its parent. So what is not
 * committed yet is shown as a branch's last commit is, by every view that
 * reads a commit.
 *
 * Nothing the worktree's owner has moves: the files are added to a copy of
 * its index, kept out of the repository, so its own index, its HEAD and
 * its files are as they were. The commit is on no branch; it and its files
 * are objects in the repository until git next prunes what nothing refers
 * to. Undefined when the tree cannot be read.
 */
export async function treeSnapshot(tree: string): Promise<{ sha: string; uncommitted: boolean } | undefined> {
  const head = await gitAsync(tree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.code !== 0) return undefined;
  const sha = head.stdout.trim();
  const status = await gitAsync(tree, ['status', '--porcelain']);
  if (status.code !== 0) return undefined;
  if (status.stdout.trim() === '') return { sha, uncommitted: false };

  const index = await gitAsync(tree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const copy = join(tmpdir(), `yan-index-${randomBytes(6).toString('hex')}`);
  const git = (args: readonly string[]): ReturnType<typeof runProcessAsync> =>
    runProcessAsync('git', ['-C', tree, '-c', 'core.quotePath=false', ...args], { timeoutMs: 60_000, env: { ...process.env, GIT_INDEX_FILE: copy } });
  try {
    // The index as it is, so only what changed since is read again; a tree with none yet starts from HEAD's.
    await copyFile(index.stdout.trim(), copy).catch(async () => { await git(['read-tree', 'HEAD']); });
    if ((await git(['add', '-A'])).code !== 0) return undefined;
    const written = await git(['write-tree']);
    if (written.code !== 0) return undefined;
    const made = await git(['-c', 'user.name=yan serve', '-c', 'user.email=yan@localhost', 'commit-tree', written.stdout.trim(), '-p', sha, '-m', 'Not committed yet']);
    return made.code === 0 ? { sha: made.stdout.trim(), uncommitted: true } : undefined;
  } finally {
    await rm(copy, { force: true });
    await rm(`${copy}.lock`, { force: true });
  }
}
