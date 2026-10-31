import { Command } from 'commander';
import { action, collect, out } from './shared/action.js';
import { requiredTask } from './shared/task-id.js';
import { uatLines } from './shared/uat.js';
import { Uat, UAT_SIDES } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan uat` — what `user` checks each deliverable by, recorded in
 * artifacts/uat/uat.json as the agent makes it. The record is what ties a
 * screenshot to the deliverable it proves; a report and `yan serve` read it
 * rather than guess from file names, and `yan uat` alone shows which
 * deliverable has nothing yet. `yan uat ready` hands the task to `user`
 * to accept, once the evidence is all there.
 */

interface TaskOption {
  task?: string;
}

const TASK_FLAG = ['--task <id>', 'the task; defaults to $YAN_TASK'] as const;

function show(options: TaskOption): void {
  const task = requiredTask(options.task, '--task <id>');
  const uat = new Uat(task);
  const lines = uatLines(task.read().deliverables, uat.read(), uat.dir);
  if (lines.length === 0) out('no deliverables to check');
  for (const l of lines) out(l);
}

const add = new Command('add')
  .description('record a screenshot or recording in uat/: the deliverables it shows, and what it shows of them')
  .argument('<file>', 'in artifacts/uat/, by its path there or in full')
  .argument('<shows...>', 'what it shows, one line')
  .requiredOption('--for <d>', 'the deliverable it shows; repeat it, or d2,d3, for several', collect)
  .option('--before', 'the before half of a pair, shot before the change')
  .option('--after', 'the after half of a pair')
  .option('--new', 'something that did not exist before, with no before to pair it with')
  .option(...TASK_FLAG)
  .action(
    action('yan uat add', (file: string, shows: string[], options: TaskOption & { for: string[]; before?: boolean; after?: boolean; new?: boolean }) => {
      const sides = UAT_SIDES.filter((s) => options[s] === true);
      if (sides.length > 1) throw YanError.usage('uat_usage', 'a file is one of --before, --after and --new, not several');
      const side = sides[0];
      const task = requiredTask(options.task, '--task <id>');
      const { path, replaced } = new Uat(task).add(file, options.for, shows.join(' '), side);
      out(`${replaced ? 'replaced' : 'recorded'} ${path} for ${options.for.join(',')} → ${task.id}`);
    }),
  );

const note = new Command('note')
  .description('for a deliverable nothing on screen can show: how it was checked')
  .argument('<how...>', 'how it was checked and what was seen, one line')
  .requiredOption('--for <d>', 'the deliverable; repeat it, or d6,d7, for several', collect)
  .option(...TASK_FLAG)
  .action(
    action('yan uat note', (how: string[], options: TaskOption & { for: string[] }) => {
      const task = requiredTask(options.task, '--task <id>');
      const ids = new Uat(task).note(options.for, how.join(' '));
      out(`noted how ${ids.join(',')} ${ids.length === 1 ? 'was' : 'were'} checked → ${task.id}`);
    }),
  );

const rm = new Command('rm')
  .description('forget a file\'s entry, or a deliverable\'s note; the file itself stays')
  .argument('<file-or-d>', 'a file as `yan uat` lists it, or d6 for its note')
  .option(...TASK_FLAG)
  .action(
    action('yan uat rm', (target: string, options: TaskOption) => {
      const task = requiredTask(options.task, '--task <id>');
      out(`forgot ${new Uat(task).remove(target)} → ${task.id}`);
    }),
  );

const ready = new Command('ready')
  .description('the task is with the user to accept (in review): say so once every deliverable is built and its evidence recorded')
  .option(...TASK_FLAG)
  .action(
    action('yan uat ready', (options: TaskOption) => {
      const task = requiredTask(options.task, '--task <id>');
      task.awaitUat();
      out(`${task.id}  in review - the user checks it, changes follow their feedback, and yan done closes it`);
    }),
  );

const ls = new Command('ls')
  .description('every deliverable with what it is checked by, and the files nothing records')
  .option(...TASK_FLAG)
  .action(action('yan uat', (options: TaskOption) => show(options)));

export const command = new Command('uat')
  .description('what the user checks each deliverable by: record each screenshot or recording in artifacts/uat/ with the deliverable it shows, as you make it')
  .addCommand(add)
  .addCommand(note)
  .addCommand(rm)
  .addCommand(ready)
  .addCommand(ls, { isDefault: true })
  .addHelpText(
    'after',
    `
The evidence is gathered deliverable by deliverable: for each one, what
would let the user see it is true. Shoot that, save it in artifacts/uat/,
and record it at once:

  yan uat add d9-after.png --for d9 --after "the video about 1000×565, the right panel folded away"
  yan uat add d2-d3.webm --for d2,d3 "dragged in on the PC, played and marked on the phone"
  yan uat note --for d6 "stopped the server and restored from the backup: two minutes lost"

A change to what the user sees is shot before it is made, with --before,
and again after, with --after. Something that did not exist before has no
before: shoot it once it is there, with --new. A deliverable nothing on
screen can show gets a note of how it was checked instead. Recording a
file again replaces its entry; a file redone keeps its name. Bare 'yan uat'
lists every deliverable with its evidence, and which have none.

Once every deliverable is built and has its evidence, 'yan uat ready' sets
the task to uat (in review): the user checks it. It stays there while changes
are made on their feedback, deliverables added or redone with their
evidence, until the user closes it with 'yan done'.`,
  );
