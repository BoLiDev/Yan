import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { repoName } from './shared/repo-name.js';
import { repoKey } from '../util/repo-key.js';
import { bold, cells, cyan, dim, gray, green, padEnd, terminalWidth, tildePath, yellow } from './shared/style.js';
import { chosenTask } from './shared/task-id.js';
import { lineText, MAX_WIDTH, PIPE_WIDTH, wrap } from './shared/wrap.js';
import { leasesHeldBy, treeState, type LeaseRow } from '../externals/worktree/index.js';
import { Drafts } from '../records/drafts/index.js';
import type { Task, TaskData } from '../records/task/index.js';
import { branchOf, remoteUrl } from '../util/git.js';
import { localDay, localStamp } from '../util/time.js';

/**
 * `yan peek [task-id]` — `user`'s glance at one task: what it is, where its
 * trees are and what they hold, the start of its problem, the resources it
 * keeps and `user`'s newest drafts. Drawn on the chain bare `yan` draws, so
 * the two read as one tool.
 *
 * It is `user`'s alone. The deliverables and the log are the agent's to
 * read, through `yan context` and `yan log`, and `user` sees the
 * deliverables when the agent changes them. Reads this machine only: no
 * fetch.
 */

/** How many drafts are listed before the rest become a count. */
const DRAFTS_SHOWN = 5;

/** The chain's pieces, as Clack draws them. */
const BAR = '│';
const START = '┌';
const END = '└';
const STEP = '◇';

function day(iso: string | undefined): string {
  return iso === undefined ? '?' : localDay(new Date(iso));
}

/** A step on the chain: its title, an aside dimmed beside it, and its lines under the bar. */
function section(title: string, aside: string, body: readonly string[]): string[] {
  return [
    gray(BAR),
    `${green(STEP)}  ${title}${aside === '' ? '' : `  ${dim(aside)}`}`,
    ...body.map((line) => (line === '' ? gray(BAR) : `${gray(BAR)}  ${line}`)),
  ];
}

function headLines(task: Task, data: TaskData): string[] {
  const created = `created ${day(data.createdAt)}`;
  const notes = `notes in ${tildePath(task.dir)}`;
  const state = data.state === 'open'
    ? `${green('open')}${dim(` · ${created} · ${notes}`)}`
    : dim([`${data.state} ${day(data.closedAt)}`, created, ...(data.reason === undefined ? [] : [data.reason]), notes].join(' · '));
  return [`${gray(START)}  ${bold(`${task.id}  ${data.title}`)}`, `${gray(BAR)}  ${state}`];
}

/**
 * Two lines per repository, its name and where its tree is, then its branch
 * and what the tree holds that exists nowhere else; one, with the branch the
 * task keeps, when it has no tree here; another for the packages the task is
 * about in it.
 */
function treeLines(task: Task, data: TaskData): string[] {
  if (data.repos.length === 0) return [dim('no repository')];
  const held = leasesHeldBy(task.id);
  const names = data.repos.map((r) => repoName(r.url));
  const width = Math.max(...names.map(cells));
  const under = ' '.repeat(width + 2);
  const lines: string[] = [];
  data.repos.forEach((repo, i) => {
    const name = padEnd(names[i] as string, width);
    const lease = held.find((l) => repoKey(remoteUrl(l.path) ?? '') === repoKey(repo.url));
    if (lease === undefined) {
      lines.push(`${name}  ${dim(`none on this machine${repo.branch === undefined ? '' : ` · branch ${repo.branch}`}`)}`);
    } else {
      lines.push(`${name}  ${tildePath(lease.path)}`, `${under}${treeNotes(lease)}`);
    }
    if (repo.scope !== undefined && repo.scope.length > 0) lines.push(`${under}${dim(`about ${repo.scope.join(', ')}`)}`);
  });
  return lines;
}

/** The branch the agent put a tree on, or that it has none yet, and what it holds that exists nowhere else. */
function treeNotes(lease: LeaseRow): string {
  let branch = 'detached HEAD';
  try {
    branch = branchOf(lease.path) ?? branch;
  } catch {
    // Said as detached; the notes below say what git can tell.
  }
  // A glance, not the guard: edits inside submodules are `yan done`'s to find.
  const { dirty, unpushed } = treeState(lease.path, { submoduleEdits: false });
  const notes = [dirty.length > 0 ? yellow(`${dirty.length} changed`) : '', unpushed ? yellow('unpushed') : ''].filter((s) => s !== '');
  return [dim(branch), ...notes].join(dim(' · '));
}

/** A line that starts a piece of its own rather than continuing the one above: a heading, an item, a quote. */
const OWN_LINE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/;
const HEADING = /^\s*#{1,6}\s/;

/**
 * A paragraph of markdown as the pieces it wraps in: prose hard-wrapped in
 * the file is joined back into one, so it wraps to this terminal instead.
 */
function pieces(paragraph: string): string[] {
  const out: string[] = [];
  for (const raw of paragraph.split(/\r?\n/)) {
    const last = out[out.length - 1];
    if (last === undefined || OWN_LINE.test(raw) || HEADING.test(last)) out.push(raw.trim());
    else out[out.length - 1] = `${last} ${raw.trim()}`;
  }
  return out;
}

const isHeading = (paragraph: string): boolean => paragraph.split(/\r?\n/).every((l) => HEADING.test(l));

/**
 * The start of the problem, wrapped to the terminal: its first paragraph,
 * with the heading above it when it opens with one, and how much more there
 * is. The whole of it is in the file, which `yan context` prints.
 */
function problemLines(task: Task): { file: string; lines: string[] } {
  let text = '';
  try {
    text = readFileSync(task.problem, 'utf8').trim();
  } catch {
    text = '';
  }
  const file = basename(task.problem);
  if (text === '') return { file, lines: [dim('nothing written yet')] };

  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter((p) => p !== '');
  let shown = 1;
  while (shown < paragraphs.length && isHeading(paragraphs[shown - 1] as string)) shown += 1;
  const width = Math.min(terminalWidth() ?? PIPE_WIDTH, MAX_WIDTH) - 1 - 3;
  const lines = paragraphs.slice(0, shown).flatMap((p, i) => [
    ...(i === 0 ? [] : ['']),
    ...pieces(p).flatMap((piece) => wrap(piece, width).map(lineText)),
  ]);
  const more = paragraphs.length - shown;
  if (more > 0) lines.push(dim(`… ${more} more paragraph${more === 1 ? '' : 's'}`));
  return { file, lines };
}

/** One line per resource, the names padded to one column. */
function resourceLines(resources: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(resources);
  if (entries.length === 0) return [dim('none yet')];
  const width = Math.max(...entries.map(([name]) => cells(name)));
  return entries.map(([name, where]) => `${padEnd(name, width)}  ${cyan(where)}`);
}

function peekLines(task: Task): string[] {
  const data = task.read();
  const problem = problemLines(task);
  const lines = [
    ...headLines(task, data),
    ...section('Trees', '', treeLines(task, data)),
    ...section('Problem', problem.file, problem.lines),
    ...section('Resources', '', resourceLines(data.resources)),
  ];

  const drafts = new Drafts(task.id);
  const listed = drafts.list({ limit: DRAFTS_SHOWN });
  if (listed.length > 0) {
    const more = drafts.count() - listed.length;
    lines.push(...section('Drafts', more > 0 ? `${more} more: 'yan draft ls'` : '', listed.map((d) => `${dim(localStamp(new Date(d.updated)))}  ${d.title}`)));
  }
  lines.push(gray(END));
  return lines;
}

export const command = new Command('peek')
  .description("your glance at one task: its trees, the start of its problem, its resources and drafts - an agent reads 'yan context'")
  .argument('[task-id]', 'defaults to $YAN_TASK, or asks at a terminal')
  .action(
    action('yan peek', async (given: string | undefined) => {
      const task = await chosenTask(given, 'yan peek', 'Which task?');
      for (const line of peekLines(task)) out(line);
    }),
  );
