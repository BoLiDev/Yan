import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { paneOfEnterLock } from './shared/enter-lock.js';
import { checkSendLength, type LineSender } from './send.js';
import { typedInput } from '../externals/harness/index.js';
import { Terminal, type ReadFormat, type ReadSource } from '../externals/herdr/index.js';
import { Shift, recordUndelivered, undeliveredFile } from '../records/shift/index.js';
import { YanError } from '../util/error.js';
import { sleepMs } from '../util/process.js';

/**
 * `yan report <state> "<note>"` — the shift → yan channel, and the only
 * command a shift needs. It appends one timestamped line to `run/status` and
 * then types the note into yan's own pane, the same way `yan send` types a
 * line into a shift's. Every harness queues input arriving while it works, so
 * the note lands as a user message in yan's conversation, whatever yan is in
 * the middle of.
 *
 * Five states, and any other is refused:
 *
 *   started         the agent booted and read its brief; recorded, and not
 *                   sent, since there is nothing for yan to act on
 *   done            with the scenario's deliverable in the note, e.g. `mr <url>`;
 *                   refused until the shift has written outcome.md
 *   blocked         it is waiting on something
 *   needs-decision  it needs an answer from yan
 *   conflict        the merge has conflicts
 *
 * Nothing watches a shift, so this is the whole of how yan learns anything: a
 * note that cannot be delivered is kept in `run/undelivered`, which `yan
 * show` and the next session start print.
 *
 * One thing is not queued: a line typed while `user` is half-way through
 * their own. `agent prompt` appends to the prompt box and submits it, so the
 * note would go out inside `user`'s sentence. A report therefore waits while
 * that box has text in it, for up to three minutes, and then fails with
 * nothing recorded so the shift can come back.
 */

const REPORT_STATES = ['started', 'done', 'blocked', 'needs-decision', 'conflict'] as const;

/** How many times a note is offered to yan's pane, from `$YAN_REPORT_TRIES`. */
function deliveryTries(): number {
  const n = Number.parseInt(process.env.YAN_REPORT_TRIES ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

/** The pause between those attempts, from `$YAN_REPORT_PAUSE_MS`. */
function deliveryPauseMs(): number {
  const n = Number.parseInt(process.env.YAN_REPORT_PAUSE_MS ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 7000;
}

/** How long a report waits for `user` to finish typing, from `$YAN_REPORT_TYPING_WAIT_MS`. */
function typingWaitMs(): number {
  const n = Number.parseInt(process.env.YAN_REPORT_TYPING_WAIT_MS ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 180_000;
}

/** How often it looks at the prompt box meanwhile, from `$YAN_REPORT_TYPING_POLL_MS`. */
function typingPollMs(): number {
  const n = Number.parseInt(process.env.YAN_REPORT_TYPING_POLL_MS ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : 5000;
}

/**
 * What a report needs from the terminal: to type a line, and before that to
 * see the screen and know which harness drew it.
 */
export interface ReportTerminal extends LineSender {
  read(pane: string, lines?: number, source?: ReadSource, format?: ReadFormat): string;
  agentKind(pane: string): string | undefined;
}

/** The sources a delivery uses; each defaults to the real one. */
export interface ReportDeps {
  readonly terminal?: ReportTerminal;
  /** Which pane the live yan for a task is in. */
  readonly paneOf?: (task: string) => string | undefined;
  readonly sleep?: (ms: number) => void;
}

/**
 * The note as yan will read it: its own words, with ` (<sid>)` appended when
 * it does not already name the shift. That tag is the only decoration — no
 * prefix and no state word, because the line goes into a conversation rather
 * than into a log.
 *
 * "Already names it" is a whole word: a note about `s12` does not stand in
 * for a report from `s1`.
 */
export function noteForYan(note: string, sid: string): string {
  const escaped = sid.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const named = new RegExp(`(^|[^A-Za-z0-9._-])${escaped}([^A-Za-z0-9._-]|$)`).test(note);
  return named ? note : `${note} (${sid})`;
}

/**
 * Offer the line to yan's pane once. Answers `''` when it arrived, and why
 * not otherwise. The pane is looked up on every attempt, because a yan that
 * restarts comes back in a different one.
 */
function offer(task: string, line: string, deps: ReportDeps): string {
  if (task === '') return 'this shift is not under a task, so there is no enter lock naming a pane';
  const pane = (deps.paneOf ?? paneOfEnterLock)(task);
  if (pane === undefined) {
    return `no live yan holds task ${task}'s enter lock, so nothing is running to read this`;
  }
  try {
    (deps.terminal ?? new Terminal()).send(pane, line);
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Type the line into yan's pane, retrying while it will not go: yan sitting
 * in a dialog, no yan running, or Herdr out of reach are all states that pass
 * within seconds. Answers `''` once it lands, and the last reason otherwise.
 */
function deliver(task: string, line: string, deps: ReportDeps = {}): string {
  const tries = deliveryTries();
  const pause = deliveryPauseMs();
  const wait = deps.sleep ?? sleepMs;

  let why = '';
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    why = offer(task, line, deps);
    if (why === '') return '';
    if (attempt < tries) wait(pause);
  }
  return why;
}

/**
 * What `user` has typed into yan's prompt box and not sent, `''` for an empty
 * box, and `undefined` when there is nothing to go on: the screen cannot be
 * read, shows no prompt box, or belongs to a harness whose box the harness
 * module does not know. Never throws.
 */
function typedInYanPane(pane: string, deps: ReportDeps): string | undefined {
  try {
    const terminal = deps.terminal ?? new Terminal();
    const kind = terminal.agentKind(pane);
    if (kind === undefined) return undefined;
    return typedInput(kind, terminal.read(pane, 40, 'visible', 'ansi'));
  } catch {
    return undefined;
  }
}

/**
 * Hold the report while `user` is typing in yan's pane, looking again every
 * few seconds for up to `typingWaitMs`. Runs before the event is written, so
 * a report that gives up leaves no status line for the retry to duplicate.
 * No live yan, or a screen with no prompt box on it, holds nothing: `deliver`
 * deals with those.
 *
 * @throws YanError `report_user_typing`, exit 3, when the box still has text
 *   in it at the end.
 */
function waitWhileUserTypes(task: string, deps: ReportDeps = {}): void {
  if (task === '') return;
  const pane = (deps.paneOf ?? paneOfEnterLock)(task);
  if (pane === undefined) return;

  const poll = typingPollMs();
  const waitMs = typingWaitMs();
  const looks = Math.max(1, Math.ceil(waitMs / poll));
  const wait = deps.sleep ?? sleepMs;
  for (let look = 1; look <= looks; look += 1) {
    const typed = typedInYanPane(pane, deps);
    if (typed === undefined || typed === '') return;
    if (look < looks) wait(poll);
  }
  throw new YanError('report_user_typing', `user has been typing in yan's pane (${pane}) for the last ${Math.round(waitMs / 1000)}s, and this note would land inside their line - nothing was recorded; run the same report again in a minute`,
    { exitCode: 3 },
  );
}

interface ReportOptions {
  sid?: string;
}

/**
 * Record the event and tell yan about it.
 *
 * @throws YanError `report_usage` for anything wrong with the state, the note
 *   or who is reporting, `report_no_outcome` for a `done` with no handover
 *   written, and `report_user_typing` when `user` kept typing in yan's pane
 *   for the whole wait. Nothing is written when one of these throws.
 */
export function reportEvent(
  state: string | undefined,
  note: string | undefined,
  options: ReportOptions = {},
  deps: ReportDeps = {},
): void {
  // Checked first, so a refused state writes nothing at all.
  if (state === undefined || state === '') {
    throw YanError.usage('report_usage', `a state is required - one of: ${REPORT_STATES.join(' ')}`);
  }
  if (!(REPORT_STATES as readonly string[]).includes(state)) {
    throw YanError.usage('report_usage', `'${state}' is not a shift state - use one of: ${REPORT_STATES.join(' ')}`,
    );
  }
  if (note === undefined || note === '') {
    throw YanError.usage('report_usage', 'a note is required - say in one line what yan has to act on');
  }
  if (note.includes('\n')) {
    throw YanError.usage('report_usage', 'a note is one line - every line in run/status is one event, so a newline would forge a second one',
    );
  }

  // A shift reports about itself, so the id comes from its environment.
  const shift =
    options.sid !== undefined && options.sid !== '' ? Shift.resolve(options.sid) : Shift.fromEnv();
  if (shift === undefined) {
    throw YanError.usage('report_usage', 'cannot tell which shift is reporting - set YAN_SHIFT_DIR (or YAN_TASK_DIR and YAN_SID) as the spawn step does, or pass --sid <sid>',
    );
  }

  // The handover has to exist before the event that sends yan to read it.
  if (state === 'done' && !existsSync(join(shift.dir, 'outcome.md'))) {
    throw new YanError('report_no_outcome', `write ${join(shift.dir, 'outcome.md')} first, then report done again - it is the handover yan reads before merging, and your brief says what goes in it`,
      { exitCode: 2 },
    );
  }

  // The note is typed into a pane, so it is held to the line `yan send`
  // allows - checked before anything is written, like every refusal above.
  const line = noteForYan(note, shift.sid);
  if (state !== 'started') {
    checkSendLength(line, 'report_usage');
    // Last of the refusals, and the only one that takes time: nothing is
    // recorded until user's prompt box is clear for the note to go into.
    waitWhileUserTypes(shift.task, deps);
  }

  shift.appendEvent(state, note);
  out(`recorded ${state} in ${join(shift.run, 'status')}`);

  // `started` says the shift read its brief, which is nothing yan has to act
  // on: four shifts dispatched together would otherwise cost four messages
  // that each end in "nothing to do".
  if (state === 'started') return;

  const why = deliver(shift.task, line, deps);
  if (why === '') {
    out('delivered to yan');
    return;
  }
  recordUndelivered(shift.run, state, note);
  out(`NOT delivered to yan: ${why}`);
  out(`it is recorded in ${undeliveredFile(shift.run)}, which 'yan show' and the next session start print`);
}

export const command = new Command('report')
  .description('a shift tells yan what happened')
  .argument('[state]', `one of: ${REPORT_STATES.join(' ')}`)
  .argument('[note]', 'one short line saying what happened')
  .option('--sid <sid>', 'which shift is reporting (yan and tests only)')
  .addHelpText(
    'after',
    `
Appends the event to run/status and types the note into yan's pane, where it
arrives as a line in yan's conversation - except \`started\`, which is recorded
and not sent. \`done\` is refused, and nothing is written, until the shift
directory has outcome.md.

The note is what yan reads, so write it the way you would tell a colleague:
who you are, what happened, where to look. Your sid is appended when the note
does not already carry it, and nothing else is added.

A note that will not go - yan in a dialog, no yan running, no herdr - is
retried for about thirty seconds and then kept in run/undelivered, which
'yan show' and the next session start print. The command still exits 0.

While user is typing in yan's pane the note would land inside their line, so
the command waits for the prompt box to clear, up to three minutes, and then
exits 3 with nothing recorded: run the same report again in a minute. It can
read the prompt box of claude and codex; under another harness it sends at once.

Which shift is reporting is normally taken from the environment the spawn
step set (YAN_SHIFT_DIR, or YAN_TASK_DIR plus YAN_SID); --sid is for yan
itself and for tests.`,
  )
  .action(
    action('report', (state: string | undefined, note: string | undefined, options: ReportOptions) => {
      reportEvent(state, note, options);
    }),
  );
