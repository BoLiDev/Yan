import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { deliverableLines, deliverableTally } from './shared/deliverables.js';
import { resourceLines } from './shared/resources.js';
import { repoKey } from '../util/repo-key.js';
import { bold, dim, green, terminalWidth, tildePath, yellow } from './shared/style.js';
import { chosenTask } from './shared/task-id.js';
import { leasesHeldBy, treeState, type LeaseRow } from '../externals/worktree/index.js';
import { Drafts } from '../records/drafts/index.js';
import type { Task, TaskData } from '../records/task/index.js';
import { currentBranch, remoteUrl } from '../util/git.js';
import { localDay, localStamp } from '../util/time.js';

/**
 * `yan peek [task-id]` — one task at a glance: what it is, where its trees are
 * and what they hold, its problem, its deliverables, its resources and
 * `user`'s newest drafts. The log is `yan log`'s. Reads this machine only:
 * no fetch.
 */

/** How many drafts are listed before the rest become a count. */
const DRAFTS_SHOWN = 5;

function day(iso: string | undefined): string {
  return iso === undefined ? '?' : localDay(new Date(iso));
}

function stateLine(data: TaskData): string {
  const created = `created ${day(data.createdAt)}`;
  if (data.state === 'open') return `${green('open')} · ${created}`;
  const closed = `${data.state} ${day(data.closedAt)}`;
  return `${dim(closed)} · ${created}${data.reason === undefined ? '' : ` · ${data.reason}`}`;
}

/**
 * One line per repository: where its tree is, its branch, and what it holds
 * that exists nowhere else, then the packages the task is about in it.
 */
function treeLines(task: Task, data: TaskData): string[] {
  const held = leasesHeldBy(task.id);
  const lines: string[] = [];
  for (const repo of data.repos) {
    const lease = held.find((l) => repoKey(remoteUrl(l.path) ?? '') === repoKey(repo.url));
    lines.push(`tree  ${lease === undefined ? `none on this machine (${repoKey(repo.url)})` : treeLine(lease)}`);
    if (repo.scope !== undefined) lines.push(`      scope ${repo.scope.join(', ')}`);
  }
  return lines;
}

/** Where a tree is, its branch, and what it holds that exists nowhere else. */
function treeLine(lease: LeaseRow): string {
  let branch = lease.branch;
  try {
    branch = currentBranch(lease.path);
  } catch {
    // The lease's own record of it, then.
  }
  // A glance, not the guard: edits inside submodules are `yan done`'s to find.
  const { dirty, unpushed } = treeState(lease.path, { submoduleEdits: false });
  const notes = [
    dirty.length > 0 ? yellow(`${dirty.length} changed`) : '',
    unpushed ? yellow('unpushed') : '',
  ].filter((s) => s !== '');
  return `${tildePath(lease.path)}  ${branch}${notes.length === 0 ? '' : `  · ${notes.join(' · ')}`}`;
}

/**
 * The problem under the file it is in, which is always named: a task from
 * before problem.md keeps its brief.md, and an agent told about problem.md
 * would otherwise start a second file beside it.
 */
function problemLines(task: Task): string[] {
  const file = task.problem;
  let text = '';
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    text = '';
  }
  return [`problem  ${tildePath(file)}`, ...(text === '' ? [dim('nothing written yet')] : text.split(/\r?\n/))];
}

function peekLines(task: Task): string[] {
  const data = task.read();
  const lines = [`${bold(task.id)}  ${bold(data.title)}`, stateLine(data)];
  lines.push(...treeLines(task, data));
  lines.push(`dir   ${tildePath(task.dir)}`, '', ...problemLines(task), '');

  const tally = deliverableTally(data.deliverables);
  if (data.deliverables.length === 0) {
    lines.push(dim("no deliverables yet - 'yan deliverable add \"<text>\"'"));
  } else {
    lines.push(`deliverables  ${tally}`);
    lines.push(...deliverableLines(data.deliverables, { aside: dim }, terminalWidth()));
  }

  const resources = resourceLines(data.resources);
  if (resources.length > 0) lines.push('', 'resources', ...resources);

  const drafts = new Drafts(task.id);
  const listed = drafts.list({ limit: DRAFTS_SHOWN });
  if (listed.length > 0) {
    const more = drafts.count() - listed.length;
    lines.push('', `drafts${more > 0 ? `  (${more} more: 'yan draft ls')` : ''}`);
    for (const d of listed) lines.push(`  ${d.id}  ${dim(localStamp(new Date(d.updated)))}  ${d.title}`);
  }
  return lines;
}

export const command = new Command('peek')
  .description('one task at a glance: its trees, problem, deliverables, resources and drafts')
  .argument('[task-id]', 'defaults to $YAN_TASK, or asks at a terminal')
  .action(
    action('yan peek', async (given: string | undefined) => {
      const task = await chosenTask(given, 'yan peek', 'Which task?');
      for (const line of peekLines(task)) out(line);
    }),
  );
