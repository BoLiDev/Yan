import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { repoDir } from './shared/repo.js';
import { RemoteGit, type MrCreateOptions } from '../externals/remote-git/index.js';
import { Log } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { remoteBranchExists } from '../util/git.js';

/**
 * `yan mr` — open the outbound merge request, integration branch → target.
 *
 * Why this is a separate command from `yan land`.
 *
 * Authority, and nothing else:
 *
 *   open the outbound MR from the integration branch to `target`
 *                                        yan, on its own, because opening an
 *                                        MR is reversible
 *   merge the outbound MR into `target`  `user` has to ask for it
 *
 * Two rows of that table, two files. Splitting them is the whole point: `yan`
 * may run this one without being told, because an MR that should not exist can
 * be closed and nothing outside `user`'s own branches has changed. It may not
 * run `yan land`, because that writes into `target`, which colleagues own.
 *
 * There are two levels of review, which is why this MR matters: shift branches
 * merge into the integration branch as internal checkpoints nobody outside
 * sees, and this is the single merge request colleagues actually review. Its
 * size is the size of the unit.
 *
 * What it does not do.
 *
 *   * it does not push. Opening a merge request and deciding that a branch is
 *     ready to be published are two different judgements, and one command that
 *     did both would make the second one invisible. If the branch is not on the
 *     remote yet, this says so and stops;
 *   * it does not comment on anything, and it never mentions anyone
 *     — that interrupts colleagues, so `user` has to ask for it;
 *   * it does not know which host this machine uses. Everything remote goes
 *     through `externals/remote-git`, which is the only module allowed to know.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 1 it did not work.
 */

/** What `yan mr` needs from the host. `RemoteGit.createMr` is the real one. */
export type MrCreator = (options: MrCreateOptions) => string;

export interface MrOptions {
  task?: string;
  unit?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  draft?: boolean;
  json?: boolean;
}

export interface MrResult {
  readonly version: 1;
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  readonly target: string;
  readonly mr: string;
  readonly draft: boolean;
}

/** The command without the process around it: everything that decides is here. */
export function openMr(options: MrOptions, createMr?: MrCreator): MrResult {
  const task = options.task ?? '';
  const unitName = options.unit ?? '';

  if (task === '') throw CommandError.usage('mr', '--task is required');
  if (unitName === '') throw CommandError.usage('mr', '--unit is required');
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw CommandError.usage('mr', '--body and --body-file are alternatives - pass one');
  }

  if (!Task.exists(task)) throw CommandError.usage('mr', `no such task: ${task} - 'yan ls' lists them`);
  const record = new Task(task);
  const unit = record.findUnit(unitName);
  if (unit === undefined) {
    throw CommandError.usage('mr', `no such unit: ${unitName} in ${task} - 'yan ls ${task}' lists them`);
  }
  const data = unit.read();

  // The four refusals. `mode` decides whether an MR is the deliverable at all:
  // a `branch` unit delivers a clean local branch, a `scout` delivers a report,
  // and neither opens a merge request.
  if (data.mode === 'scout') {
    throw CommandError.usage('mr', `unit ${unitName} is a scout: it delivers a report and artifacts, and never pushes or opens an MR. If that is wrong, 'user' has to ask for 'yan unit set --mode mr'`,
    );
  }
  if (data.mode === 'branch') {
    throw CommandError.usage('mr', `unit ${unitName} is mode 'branch': its deliverable is a clean local branch and it does not open an MR. If that is wrong, 'user' has to ask for 'yan unit set --mode mr'`,
    );
  }
  if (data.mode !== 'mr') {
    throw CommandError.usage('mr', `unit ${unitName} has an unusable mode '${String(data.mode)}'`);
  }
  if (data.mr !== null && data.mr !== '') {
    throw CommandError.usage('mr', `unit ${unitName} already has an outbound merge request: ${data.mr}. One round has one outbound MR - to start a new round, 'user' has to ask for 'yan unit set --branch <new>'`,
    );
  }
  if (data.branch === '') {
    throw new CommandError('mr', 'no_branch', `unit ${unitName} has no integration branch recorded - 'yan unit add' should have set one`,
    );
  }
  if (data.target === '') {
    throw new CommandError('mr', 'no_target', `unit ${unitName} has no target recorded, and yan never guesses one`,
    );
  }
  if (data.branch === data.target) {
    throw CommandError.usage('mr', `unit ${unitName}'s integration branch and target are both '${data.branch}' - there is nothing to merge into anything`,
    );
  }

  const clone = repoDir('mr', data.repo, `register it with 'yan repo add'`);

  // The branch has to be on the remote before a merge request can point at it.
  // This only checks and reports: pushing is a separate act with its own
  // moment, and it is not this command's to perform silently.
  if (!remoteBranchExists(clone, data.branch)) {
    throw new CommandError('mr', 'not_pushed', `${data.branch} is not on the remote yet, so there is nothing to open a merge request from - push it first (git push -u origin ${data.branch})`,
    );
  }

  let title = options.title ?? '';
  if (title === '') {
    title = record.title() || `${task} ${unitName}`;
    if (record.read().units.length > 1) title = `${title} (${unitName})`;
  }

  let bodyFile = options.bodyFile;
  if (options.body === undefined && bodyFile === undefined) {
    const brief = join(record.dir, 'brief.md');
    if (existsSync(brief)) bodyFile = brief;
  }

  const create = createMr ?? ((o: MrCreateOptions) => new RemoteGit().createMr(o));
  const url = create({
    dir: clone,
    source: data.branch,
    target: data.target,
    title,
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(bodyFile !== undefined ? { bodyFile } : {}),
    ...(options.draft === true ? { draft: true } : {}),
  });
  if (url === '') {
    throw new CommandError('mr', 'no_url', 'the host reported success but printed no merge request URL - nothing was recorded',
    );
  }

  // `mr` is one of the unit's four current scalars, and it is written only
  // after the host has confirmed the URL: a recorded MR that does not exist
  // would later be read as "this round was delivered".
  try {
    unit.set('mr', url);
  } catch (err) {
    throw new CommandError('mr', 'not_recorded', `the merge request is open at ${url} but task.json was not updated - record it with 'yan unit set' or re-run after fixing the error above`,
      { cause: err },
    );
  }

  try {
    new Log(task).append(`${unitName}  outbound MR opened: ${data.branch} → ${data.target}  ${url}`);
  } catch {
    process.stderr.write('yan mr: the MR was recorded in task.json but log.md was not appended to\n');
  }

  return {
    version: 1,
    task,
    unit: unitName,
    branch: data.branch,
    target: data.target,
    mr: url,
    draft: options.draft === true,
  };
}

export const command = new Command('mr')
  .description('open the outbound merge request: integration branch → target')
  .option('--task <id>', 'the task the unit belongs to')
  .option('--unit <name>', 'the unit name')
  .option('--title <text>', "defaults to the task's title")
  .option('--body <text>', 'the merge request body')
  .option('--body-file <path>', "defaults to the task's brief.md when it exists")
  .option('--draft', 'open it as a draft')
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
usage: yan mr --task <id> --unit <name> [--title <text>]
              [--body <text> | --body-file <path>] [--draft] [--json]

Opens the outbound merge request for one unit: its integration branch into its
target. The URL is recorded in unit.mr.

\`yan\` may do this on its own: opening an MR is reversible.
Merging it into target is \`yan land\`, and \`user\` has to ask for that.`,
  )
  .action(
    action('yan mr', (options: MrOptions) => {
      const r = openMr(options);
      if (options.json === true) {
        out(JSON.stringify(r));
        return;
      }
      out(`${r.task} ${r.unit}  ${r.branch} → ${r.target}`);
      out(`mr       ${r.mr}`);
      out('');
      out(`Merging it into ${r.target} is \`yan land\`, and \`user\` has to ask for that.`);
    }),
  );
