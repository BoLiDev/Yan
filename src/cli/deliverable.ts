import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { deliverableLines, deliverableTally } from './shared/deliverables.js';
import { noted, readNote } from './shared/note.js';
import { terminalWidth } from './shared/style.js';
import { insideTask } from './shared/task-id.js';
import { Log, type LogType } from '../records/log/index.js';
import { Deliverables, Task, type Deliverable } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan deliverable` — the requirements this task is ticking off: what has
 * to be true when it is done. One subcommand per move, because the record is
 * an attribute of the task rather than a file anybody edits: every mark has a
 * command behind it, and every command writes its own log line, so `log.md` says how
 * the deliverables moved while `deliverable.json` says what they are.
 *
 * It reads `$YAN_TASK` like every other command, and never prompts.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 1 it did not work.
 */

/** The task this is running in, refusing early when it is not a task at all. */
function taskId(): string {
  const id = insideTask('deliverable');
  if (!Task.exists(id)) throw YanError.usage('deliverable_usage', `no such task: ${id} - 'yan ls' lists them`);
  return id;
}

/**
 * Append the one line this write earns. A failed log is reported and never
 * fatal: the record is already written, and losing the narration is not worth
 * refusing over.
 */
function log(task: string, type: LogType, line: string, note: string): void {
  try {
    new Log(task).append(type, noted(line, note));
  } catch {
    process.stderr.write('yan deliverable: the record was written but log.md was not appended to\n');
  }
}

/** Commander's repeatable-option accumulator. */
function collect(value: string, previous: readonly string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** @throws YanError `deliverable_usage` when no id was given. */
function requireId(id: string | undefined, spelled: string): string {
  if (id === undefined || id.trim() === '') {
    throw YanError.usage('deliverable_usage', `which deliverable? ${spelled} - 'yan deliverable ls' lists them`);
  }
  return id.trim();
}

/** What a writing subcommand prints: the deliverable as the list shows it. */
function show(d: Deliverable): void {
  for (const line of deliverableLines([d], {}, terminalWidth())) out(line);
}

const quoted = (d: Deliverable): string => `"${d.text}"`;

// --- ls ---------------------------------------------------------------------

const ls = new Command('ls')
  .description("this task's deliverables, in file order")
  .option('--json', "the file's object, as it is on disk")
  .action(
    action('yan deliverable ls', (options: { json?: boolean }) => {
      const record = new Deliverables(taskId());
      const file = record.read();
      if (options.json === true) {
        out(JSON.stringify(file));
        return;
      }
      if (file.deliverables.length === 0) {
        out(`no deliverables yet  ${record.file}`);
        out("Break the brief down with 'yan deliverable add \"<text>\"'.");
        return;
      }
      for (const line of deliverableLines(file.deliverables, {}, terminalWidth())) out(line);
      out('');
      out(`${deliverableTally(file.deliverables)}  ${record.file}`);
    }),
  );

// --- add --------------------------------------------------------------------

const add = new Command('add')
  .description('append one or several deliverables, in the order given')
  .argument('[text...]', 'the requirement, as a statement of what has to be true')
  .option('--note <text>', 'one line for log.md: what the command cannot know')
  .addHelpText(
    'after',
    `
A deliverable is a requirement: a statement of something that has to be true
when the task is done, written before the work starts. Its subject is the
product, never the work - "the UI shows the title, and the title is green",
not "a test renders every August invoice and compares the totals", which is a
step somebody took.

Write one at the grain of a user story - one thing a user can do or see - and
not at the grain of a test assertion: what one story covers is one deliverable
even when it takes several statements to say, and a bug fix may be as specific
as the bug. Six lines about the work report are one deliverable:

  yan deliverable add "yan ui opens a work report in the browser of everything \\
                       user worked on: what was done and what is left over a \\
                       date range, with totals by week and by project."

The list is the task's goal as user and the agent have agreed it, so it stays
aligned with user at all times: it changes in the turn user says what the task
is for has changed, and they see it as it then stands.`,
  )
  .action(
    action('yan deliverable add', (texts: string[] | undefined, options: { note?: string }) => {
      const note = readNote('deliverable', options.note);
      const task = taskId();
      const given = texts ?? [];
      if (given.length === 0) {
        throw YanError.usage('deliverable_usage', 'nothing to add - pass the text of at least one deliverable');
      }
      const added = new Deliverables(task).add(given);
      log(task, 'changed', `${added.map((d) => d.id).join(' ')}  added: ${added.map(quoted).join(' · ')}`, note);
      for (const d of added) show(d);
    }),
  );

// --- set --------------------------------------------------------------------

const set = new Command('set')
  .description('reword one, keeping its id and its status')
  .argument('[id]', 'the deliverable id, d1, d2…')
  .argument('[text]', 'the new text')
  .option('--note <text>', 'one line for log.md: why it was reworded')
  .action(
    action('yan deliverable set', (id: string | undefined, text: string | undefined, options: { note?: string }) => {
      const note = readNote('deliverable', options.note);
      const task = taskId();
      const which = requireId(id, "yan deliverable set <id> '<text>'");
      if (text === undefined) throw YanError.usage('deliverable_usage', 'the new text is required');
      const d = new Deliverables(task).set(which, text);
      log(task, 'changed', `${d.id}  reworded: ${quoted(d)}`, note);
      show(d);
    }),
  );

// --- done -------------------------------------------------------------------

interface DoneOptions {
  ref?: string[];
  at?: string;
  note?: string;
}

const done = new Command('done')
  .description('mark one delivered')
  .argument('[id]', 'the deliverable id')
  .option('--ref <text>', "repeatable; what proves it, 'PR #58' or its URL, which the report links", collect, [])
  .option('--at <date>', 'the day it was delivered, YYYY-MM-DD (default: today)')
  .option('--note <text>', 'one line for log.md: how it was verified, what is still in doubt')
  .action(
    action('yan deliverable done', (id: string | undefined, options: DoneOptions) => {
      const note = readNote('deliverable', options.note);
      const task = taskId();
      const which = requireId(id, 'yan deliverable done <id>');
      const d = new Deliverables(task).done(which, options.at ?? '', options.ref ?? []);
      const refs = (d.refs ?? []).join(' ');
      log(task, 'delivered', `${d.id}  done ${d.doneAt}${refs === '' ? '' : `, ${refs}`}: ${quoted(d)}`, note);
      show(d);
    }),
  );

// --- abandon ----------------------------------------------------------------

const abandon = new Command('abandon')
  .description('give one up, with the reason it is not being done')
  .argument('[id]', 'the deliverable id')
  .option('--reason <text>', 'REQUIRED: why it is not being done')
  .option('--note <text>', 'one line for log.md: what the reason does not say')
  .addHelpText(
    'after',
    `
The reason is required and is never guessed: an abandoned deliverable stays
in the record so the next session does not raise it again, and the reason is
the only thing that stops it.`,
  )
  .action(
    action('yan deliverable abandon', (id: string | undefined, options: { reason?: string; note?: string }) => {
      const note = readNote('deliverable', options.note);
      const task = taskId();
      const which = requireId(id, 'yan deliverable abandon <id> --reason "<why>"');
      if ((options.reason ?? '').trim() === '') {
        throw YanError.usage('deliverable_usage', "--reason is required: an abandoned deliverable stays in the record, and the reason is what stops the next session raising it again");
      }
      const d = new Deliverables(task).abandon(which, options.reason ?? '');
      log(task, 'changed', `${d.id}  abandoned: ${d.reason}`, note);
      show(d);
    }),
  );

// --- todo -------------------------------------------------------------------

const todo = new Command('todo')
  .description('back to to-do, dropping the date, the refs and the reason')
  .argument('[id]', 'the deliverable id')
  .option('--note <text>', 'one line for log.md: why it is open again')
  .action(
    action('yan deliverable todo', (id: string | undefined, options: { note?: string }) => {
      const note = readNote('deliverable', options.note);
      const task = taskId();
      const which = requireId(id, 'yan deliverable todo <id>');
      const d = new Deliverables(task).todo(which);
      log(task, 'changed', `${d.id}  back to to-do`, note);
      show(d);
    }),
  );

// --- rm ---------------------------------------------------------------------

const rm = new Command('rm')
  .description('remove one added by mistake')
  .argument('[id]', 'the deliverable id')
  .option('--note <text>', 'one line for log.md: why it should never have been there')
  .addHelpText(
    'after',
    `
For a deliverable that should never have been written, not for one that is
being given up: that is 'yan deliverable abandon <id> --reason "<why>"',
which keeps it in the record. The id is not handed out again either way.`,
  )
  .action(
    action('yan deliverable rm', (id: string | undefined, options: { note?: string }) => {
      const note = readNote('deliverable', options.note);
      const task = taskId();
      const which = requireId(id, 'yan deliverable rm <id>');
      const d = new Deliverables(task).rm(which);
      log(task, 'changed', `${d.id}  removed: ${quoted(d)}`, note);
      out(`removed ${d.id}  ${d.text}`);
    }),
  );

export const command = new Command('deliverable')
  .description('the requirements this task is ticking off')
  .addCommand(ls)
  .addCommand(add)
  .addCommand(set)
  .addCommand(done)
  .addCommand(abandon)
  .addCommand(todo)
  .addCommand(rm)
  .addHelpText(
    'after',
    `
A deliverable is a requirement: a statement of something that has to be true
when the task is done, its subject the product and never the work:
"the UI shows the title, and the title is green". One deliverable is one
thing a user can do or see - a user story, not a test assertion - and a bug
fix may be as specific as the bug. So it is an attribute of the task, not a
summary of the log: a merge request proves a deliverable, it does not define
one, and nothing is added after the fact to record work that happened.

The list is the task's goal as user and the agent have agreed it: what the
work is measured against, what a shift's brief is written from, and what
'done' means for the task. It stays aligned with user at all times - user
reads it with 'yan show' to catch drift early - so it changes in the turn
user says what the task is for has changed, and they see the list as it then
stands. 'done' says the statement is now true and has been seen to be true,
which is the bar that accepts a shift's work, not a merge request merging.

Every one of these writes one line to log.md, so the log says how the
deliverables moved and the record says what they are. --note is where the
reason goes.`,
  );
