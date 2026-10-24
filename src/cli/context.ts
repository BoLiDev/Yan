import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { deliverableLines, deliverableTally } from './shared/deliverables.js';
import { artifactLines, artifactLinker, listArtifacts } from './shared/artifacts.js';
import { progressLines, taskProgress } from './shared/progress.js';
import { byKind, resourceLines } from './shared/resources.js';
import { coverage } from './shared/uat.js';
import { terminalWidth } from './shared/style.js';
import { requiredTask } from './shared/task-id.js';
import { Uat, type Task } from '../records/task/index.js';

/**
 * `yan context` — the agent's read of a task's notes: the problem whole,
 * under the file it is in, the deliverables and the resources, then what the
 * work has produced so far: the artifacts, how many deliverables have
 * something to check them by, and where each branch stands. The
 * opening prompt names it, as a summary to start from rather than the whole
 * of what there is. `yan peek` is `user`'s glance and leaves the deliverables
 * out, so the two can each be shaped for the one who reads them.
 *
 * `--json` is the same for a skill to build on, a report or a recap, with
 * every artifact rather than each folder's count, and its web address in
 * the vault's repository.
 */

/**
 * The problem under the file it is in, which is always named: a task from
 * before problem.md keeps its brief.md, and an agent told about problem.md
 * would otherwise start a second file beside it.
 */
function problemText(task: Task): string {
  try {
    return readFileSync(task.problem, 'utf8').trim();
  } catch {
    return '';
  }
}

function problemLines(task: Task): string[] {
  const text = problemText(task);
  return [`problem  ${task.problem}`, ...(text === '' ? ['nothing written yet'] : text.split(/\r?\n/))];
}

function contextLines(task: Task): string[] {
  const data = task.read();
  const lines = [`${task.id}  ${data.title}`, '', ...problemLines(task), ''];
  if (data.state === 'uat') lines.splice(1, 0, "验收中 - 'yan uat ready' handed it to the user, who checks it; changes follow their feedback until they close it with yan done");

  if (data.deliverables.length === 0) {
    lines.push("no deliverables yet - 'yan deliverable add \"<text>\"'");
  } else {
    lines.push(`deliverables  ${deliverableTally(data.deliverables)}`);
    lines.push(...deliverableLines(data.deliverables, {}, terminalWidth()));
  }

  const resources = resourceLines(data);
  lines.push('', ...(resources.length === 0 ? ["no resources yet - 'yan resource add <kind> <name> <where>'"] : ['resources', ...resources]));

  const artifacts = artifactLines(listArtifacts(task.dir));
  lines.push('', ...(artifacts.length === 0 ? ['no artifacts yet'] : [`artifacts  ${join(task.dir, 'artifacts')}`, ...artifacts]));

  const { covered, of } = coverage(data.deliverables, new Uat(task).read());
  if (of > 0) lines.push('', `uat  ${covered} of ${of} deliverables have something to check them by - 'yan uat' lists it`);

  const progress = taskProgress(task);
  if (progress.length > 0) lines.push('', 'branches', ...progressLines(progress));
  return lines;
}

function contextJson(task: Task): unknown {
  const data = task.read();
  const link = artifactLinker(task.dir);
  return {
    id: task.id,
    title: data.title,
    state: data.state,
    createdAt: data.createdAt ?? null,
    closedAt: data.closedAt ?? null,
    problem: { file: task.problem, text: problemText(task) },
    deliverables: data.deliverables,
    resources: byKind(data),
    artifacts: listArtifacts(task.dir).map((a) => ({ ...a, file: join(task.dir, 'artifacts', a.path), url: link?.(a.path) ?? null })),
    uat: new Uat(task).read(),
    branches: taskProgress(task),
  };
}

export const command = new Command('context')
  .description('a summary of a task as it stands, for the agent working on it: the problem and its file, the deliverables, the resources, the artifacts and what each deliverable is checked by, where each branch stands')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .option('--json', 'the same as JSON, every artifact listed with its web address in the vault\'s repository')
  .addHelpText(
    'after',
    `
It is a summary of the task's folder and its worktrees, not all there is:
for more, read the files in the folder, the worktree's code and its git
history.

Artifacts are grouped as design/, docs/, uat/, misc/ and the rest, a folder in them shown
as its count of files. Each branch shows how far it is ahead of the default
branch, how many of its commits no remote branch has, and how many changes
are uncommitted in its worktree; a repository with no worktree on this
machine is read from its clone as last fetched.

With --json, uat is what 'yan uat' records: each file in artifacts/uat/
with the deliverables it shows, and the notes on how the others were
checked. An artifact's url is where it opens in the vault's repository
once the vault is pushed: /blob/ on github.com, /-/blob/ on a host with
gitlab in its name. For any other forge, set "artifactLinks" in the vault's
config.json, an http(s) address such as
"https://git.example.com/me/vault/-/blob/{branch}/{path}"; any other is
passed over.`,
  )
  .action(
    action('yan context', (options: { task?: string; json?: boolean }) => {
      const task = requiredTask(options.task, '--task <id>');
      if (options.json === true) {
        out(JSON.stringify(contextJson(task), null, 2));
        return;
      }
      for (const line of contextLines(task)) out(line);
    }),
  );
