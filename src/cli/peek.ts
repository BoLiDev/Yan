import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { deliverableLines, deliverableTally } from './shared/deliverables.js';
import { repoKey } from './shared/repo-key.js';
import { bold, dim, green, terminalWidth, tildePath, yellow } from './shared/style.js';
import { chosenTask } from './shared/task-id.js';
import { leaseHeldBy, treeState } from '../externals/worktree/index.js';
import { Drafts } from '../records/drafts/index.js';
import type { Task, TaskData } from '../records/task/index.js';
import { currentBranch } from '../util/git.js';
import { localDay, localStamp } from '../util/time.js';

/**
 * `yan peek [task-id]` — one task at a glance: what it is, where its tree is
 * and what that holds, its brief, its deliverables and `user`'s newest
 * drafts. The log is `yan log`'s. Reads this machine only: no fetch.
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

/** The tree line: where it is, its branch, and what it holds that exists nowhere else. */
function treeLine(task: Task, data: TaskData): string | undefined {
  const lease = leaseHeldBy(task.id);
  if (lease === undefined) {
    return data.repo === undefined ? undefined : `none on this machine (${repoKey(data.repo)})`;
  }
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

function briefLines(task: Task): string[] {
  let text = '';
  try {
    text = readFileSync(task.brief, 'utf8').trim();
  } catch {
    text = '';
  }
  return text === '' ? [dim(`no brief yet - ${tildePath(task.brief)}`)] : text.split(/\r?\n/);
}

function peekLines(task: Task): string[] {
  const data = task.read();
  const lines = [`${bold(task.id)}  ${bold(data.title)}`, stateLine(data)];
  const tree = treeLine(task, data);
  if (tree !== undefined) lines.push(`tree  ${tree}`);
  if (data.scope !== undefined) lines.push(`scope ${data.scope.join(', ')}`);
  lines.push(`dir   ${tildePath(task.dir)}`, '', ...briefLines(task), '');

  const tally = deliverableTally(data.deliverables);
  if (data.deliverables.length === 0) {
    lines.push(dim("no deliverables yet - 'yan deliverable add \"<text>\"'"));
  } else {
    lines.push(`deliverables  ${tally}`);
    lines.push(...deliverableLines(data.deliverables, { aside: dim }, terminalWidth()));
  }

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
  .description('one task at a glance: its tree, brief, deliverables and drafts')
  .argument('[task-id]', 'defaults to $YAN_TASK, or asks at a terminal')
  .action(
    action('yan peek', async (given: string | undefined) => {
      const task = await chosenTask(given, 'yan peek', 'Which task?');
      for (const line of peekLines(task)) out(line);
    }),
  );
