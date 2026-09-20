import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { repoDir } from './shared/repo.js';
import { insideTask } from './shared/task-id.js';
import { RemoteGit, type MrCreateOptions } from '../externals/remote-git/index.js';
import { Log } from '../records/log/index.js';
import { Deliverables, Task, type Deliverable } from '../records/task/index.js';
import { remoteBranchExists } from '../util/git.js';
import { YanError } from '../util/error.js';

/**
 * `yan mr` — open the outbound merge request, integration branch → target,
 * and record its URL on the unit. `yan` may run this on its own, because an
 * MR that should not exist can be closed; merging it is `yan land`, which
 * `user` has to ask for.
 *
 * It never pushes: a branch that is not on the remote yet stops the command.
 * It never comments and never mentions anyone.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 1 it did not work.
 */

/** What `yan mr` needs from the host. `RemoteGit.createMr` is the real one. */
type MrCreator = (options: MrCreateOptions) => string;

export interface MrOptions {
  task?: string;
  unit?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  draft?: boolean;
  json?: boolean;
}

interface MrResult {
  readonly version: 1;
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  readonly target: string;
  readonly mr: string;
  readonly draft: boolean;
}

/**
 * Open the unit's outbound merge request and record its URL.
 *
 * @throws YanError `mr_usage` for a missing or contradictory argument, an
 *   unknown task or unit, one that already has an outbound MR, or one whose branch and target are the same; `mr_no_branch`,
 *   `mr_no_target` or `mr_not_pushed` for a unit that is not ready.
 */
export function openMr(options: MrOptions, createMr?: MrCreator): MrResult {
  const task = options.task ?? insideTask('mr');
  const unitName = options.unit ?? '';

  if (unitName === '') throw YanError.usage('mr_usage', '--unit is required');
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw YanError.usage('mr_usage', '--body and --body-file are alternatives - pass one');
  }

  if (!Task.exists(task)) throw YanError.usage('mr_usage', `no such task: ${task} - 'yan ls' lists them`);
  const record = new Task(task);
  const data = record.findUnit(unitName);
  if (data === undefined) {
    throw YanError.usage('mr_usage', `no such unit: ${unitName} in ${task} - 'yan show ${task}' lists them`);
  }

  if (data.mr !== null && data.mr !== '') {
    throw YanError.usage('mr_usage', `unit ${unitName} already has an outbound merge request: ${data.mr}. One round has one outbound MR - to start a new round, 'user' has to ask for 'yan unit set --branch <new>'`,
    );
  }
  if (data.branch === '') {
    throw new YanError('mr_no_branch', `unit ${unitName} has no integration branch recorded - 'yan unit add' should have set one`,
    );
  }
  if (data.target === '') {
    throw new YanError('mr_no_target', `unit ${unitName} has no target recorded, and yan never guesses one`,
    );
  }
  if (data.branch === data.target) {
    throw YanError.usage('mr_usage', `unit ${unitName}'s integration branch and target are both '${data.branch}' - there is nothing to merge into anything`,
    );
  }

  const clone = repoDir('mr', data.repo, `register it with 'yan repo add'`);

  // Checked, never pushed: publishing a branch is its own decision.
  if (!remoteBranchExists(clone, data.branch)) {
    throw new YanError('mr_not_pushed', `${data.branch} is not on the remote yet, so there is nothing to open a merge request from - push it first (git push -u origin ${data.branch})`,
    );
  }

  let title = options.title ?? '';
  if (title === '') {
    title = record.title() || `${task} ${unitName}`;
    if (record.read().units.length > 1) title = `${title} (${unitName})`;
  }

  // The default body is what the task is for and what it has to build: the
  // brief no longer says the second, so the deliverables are appended to it.
  let body = options.body;
  let bodyFile = options.bodyFile;
  if (body === undefined && bodyFile === undefined) {
    const brief = join(record.dir, 'brief.md');
    const deliverables = new Deliverables(task).readOrNone().deliverables;
    if (deliverables.length > 0) body = defaultBody(existsSync(brief) ? readFileSync(brief, 'utf8') : '', deliverables);
    else if (existsSync(brief)) bodyFile = brief;
  }

  const create = createMr ?? ((o: MrCreateOptions) => new RemoteGit().createMr(o));
  const url = create({
    dir: clone,
    source: data.branch,
    target: data.target,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(bodyFile !== undefined ? { bodyFile } : {}),
    ...(options.draft === true ? { draft: true } : {}),
  });
  if (url === '') {
    throw new YanError('mr_no_url', 'the host reported success but printed no merge request URL - nothing was recorded',
    );
  }

  // Recorded only once the host has answered with a URL.
  try {
    record.editUnit(unitName, (u) => {
      u.mr = url;
    });
  } catch (err) {
    throw new YanError('mr_not_recorded', `the merge request is open at ${url} but task.json was not updated - record it with 'yan unit set' or re-run after fixing the error above`,
      { cause: err },
    );
  }

  try {
    new Log(task).append('delivered', `${unitName}  outbound MR opened: ${data.branch} → ${data.target}  ${url}`);
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

/**
 * `brief.md` as it stands, then the deliverables as a markdown list: what the
 * task is for, and what this round is meant to have built. The marks are the
 * ones a reader of yan's own notes already knows.
 */
export function defaultBody(brief: string, deliverables: readonly Deliverable[]): string {
  const lines = deliverables.map((d) => {
    if (d.status === 'done') {
      const said = [d.doneAt, ...(d.refs ?? [])].join(' · ');
      return `- [x] ${d.text} — ${said}`;
    }
    if (d.status === 'abandoned') return `- [-] ${d.text} — abandoned: ${d.reason}`;
    return `- [ ] ${d.text}`;
  });
  const head = brief.replace(/\s+$/, '');
  return `${head === '' ? '' : `${head}\n\n`}## Deliverables\n\n${lines.join('\n')}\n`;
}

export const command = new Command('mr')
  .description('open the outbound merge request: integration branch → target')
  .option('--unit <name>', 'the unit name')
  .option('--title <text>', "defaults to the task's title")
  .option('--body <text>', 'the merge request body')
  .option('--body-file <path>', "defaults to the task's brief.md and its deliverables")
  .option('--draft', 'open it as a draft')
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
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
