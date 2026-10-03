import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { deliverableLines, deliverableTally } from './shared/deliverables.js';
import { resourceLines } from './shared/resources.js';
import { terminalWidth } from './shared/style.js';
import { requiredTask } from './shared/task-id.js';
import type { Task } from '../records/task/index.js';

/**
 * `yan context` — the agent's read of a task's notes: the problem whole,
 * under the file it is in, the deliverables and the resources. The opening
 * prompt names it. `yan peek` is `user`'s glance and leaves the deliverables
 * out, so the two can each be shaped for the one who reads them.
 */

/**
 * The problem under the file it is in, which is always named: a task from
 * before problem.md keeps its brief.md, and an agent told about problem.md
 * would otherwise start a second file beside it.
 */
function problemLines(task: Task): string[] {
  let text = '';
  try {
    text = readFileSync(task.problem, 'utf8').trim();
  } catch {
    text = '';
  }
  return [`problem  ${task.problem}`, ...(text === '' ? ['nothing written yet'] : text.split(/\r?\n/))];
}

function contextLines(task: Task): string[] {
  const data = task.read();
  const lines = [`${task.id}  ${data.title}`, '', ...problemLines(task), ''];

  if (data.deliverables.length === 0) {
    lines.push("no deliverables yet - 'yan deliverable add \"<text>\"'");
  } else {
    lines.push(`deliverables  ${deliverableTally(data.deliverables)}`);
    lines.push(...deliverableLines(data.deliverables, {}, terminalWidth()));
  }

  const resources = resourceLines(data.resources);
  lines.push('', ...(resources.length === 0 ? ["no resources yet - 'yan resource add <name> <where>'"] : ['resources', ...resources]));
  return lines;
}

export const command = new Command('context')
  .description('a task\'s notes as they stand, for the agent working on it: the problem and its file, the deliverables, the resources')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .action(
    action('yan context', (options: { task?: string }) => {
      for (const line of contextLines(requiredTask(options.task, '--task <id>'))) out(line);
    }),
  );
