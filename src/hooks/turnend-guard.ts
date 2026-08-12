import { join } from 'node:path';
import { GUARD_BUDGET, Supervision } from '../records/supervision/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { normalizePath } from '../util/paths.js';

/**
 * The blocking Stop hook, for both harnesses (supervision.md §5,
 * architecture.md §6).
 *
 * One file, two harnesses, because the question is the same one — "may this
 * turn end while shifts are still live?" — and only the evidence differs.
 *
 * claude. Block when there is still supervision responsibility and the watcher
 * is not healthy. Ending a turn while shifts are live is perfectly fine when
 * autoarm is holding `yan wait`; what is not fine is ending it with nobody on
 * duty. The guard's value shows up exactly when autoarm never ran at all —
 * broken settings, a skipped hook — and only a second hook can detect that.
 *
 *   the 800 ms wait. Both Stop hooks fire concurrently, so on a healthy turn
 *   this hook can easily ask "is the lock taken?" while autoarm is still
 *   claiming it. Waiting first is the difference between a guard and a false
 *   alarm. What earns a pass inside that window is a lock that was not there
 *   when the window opened — autoarm claiming it, with its first beacon still
 *   to come. A lock that was already there while the watcher is unhealthy does
 *   not become healthy by being looked at again, and is still a block.
 *
 *   It does not read stdin, and it does not use `stop_hook_active`. Claude sets
 *   that flag true after asyncRewake continuations too, so the very turn that
 *   needs a new watcher armed — the one right after a rewake — already looks
 *   "already continued". A one-shot guard lets exactly that turn through, which
 *   is the blind window this hook exists to close. It keeps its own count in
 *   `run/guard-failures` instead.
 *
 *   A watcher mid-reconnect is healthy. `healthy()` asks whether the watcher is
 *   still going round its loop, not whether it holds a live subscription, and
 *   that is deliberate: `yan wait` reconnects and re-subscribes when Herdr's
 *   event stream drops, and a guard that read those seconds as "nobody on duty"
 *   would block a turn over a watcher that is working exactly as designed
 *   (supervision.md §5, `records/supervision/beacon.ts`).
 *
 * codex. The primary predicate is remaining supervision responsibility, not
 * Claude's "autoarm lock plus fresh beacon". There is no autoarm on Codex and
 * no long-lived wait process between checkpoint slices, so a missing lock is
 * the normal state, not a fault. Codex may use `stop_hook_active` as a one-shot,
 * because its continuation model does not have Claude's asyncRewake blind spot.
 *
 * The blocking shape — `{"decision":"block","reason":…}` on stdout with exit 0
 * — is no longer taken from the documentation. Phase 8.5 ran it against
 * codex-cli 0.147.0: codex honoured the block, continued the turn, the model
 * acted on the reason, and `run/guard-failures` reached 2 before the turn ended
 * ([evidence §13](../../docs/v2/td/evidence.md)). What that run also showed is
 * in the comment on the reason string below.
 *
 * Fail open on purpose. The budget is 3 blocked attempts, then the guard lets
 * the turn end with a loud warning. A guard that can wedge a session forever is
 * worse than no guard: automatic supervision being broken is a thing `user` can
 * see and fix, a session that will not end is not.
 */

export type Harness = 'claude' | 'codex';

export interface GuardIo {
  /** stderr: what the Claude model reads, and where a warning goes. */
  readonly note: (line: string) => void;
  /** stdout: the Codex decision object. */
  readonly say: (line: string) => void;
  /** The harness payload, for Codex only. Bounded — see `readStdin`. */
  readonly stdin: () => Promise<string>;
}

const SETTLE_STEP_MS = 100;

export async function guard(argv: readonly string[], io: GuardIo): Promise<number> {
  let harness: Harness | undefined;
  let task = process.env.YAN_TASK ?? '';

  for (const arg of argv) {
    if (arg === '--claude' || arg === '--codex') {
      harness = arg.slice(2) as Harness;
    } else if (arg === '-h' || arg === '--help') {
      io.say('usage: hook-turnend-guard.sh --claude | --codex [<task-id>]');
      io.say('');
      io.say('Registered as a blocking Stop hook. Called by the harness, never by a');
      io.say('person and never by the model.');
      return 0;
    } else if (arg.startsWith('-')) {
      io.note(`unknown option: ${arg}`);
      return 2;
    } else {
      task = arg;
    }
  }

  if (harness === undefined) {
    io.note('say which harness this is - --claude or --codex');
    return 2;
  }

  // A guard that cannot tell whose turn this is must not hold it hostage.
  if (task === '' || !Task.isId(task) || !new Task(task).exists()) return 0;

  const sup = new Supervision(task);

  if (sup.liveCount() === 0) {
    sup.guardReset();
    return 0;
  }

  if (harness === 'claude') {
    if (sup.healthy()) {
      sup.guardReset();
      return 0;
    }
    // Kept now, because every later predicate overwrites it. This sentence is
    // the only thing the model will see about why nobody was on duty.
    const why = sup.why() === '' ? 'no watcher on duty' : sup.why();

    // Whether anybody held the lock before the wait, because that is what makes
    // the wait meaningful.
    const takenBefore = sup.lockTaken();

    // Polled in tenths rather than slept through in one go, so a turn that ends
    // with a healthy watcher pays a few milliseconds instead of the whole
    // budget. The window is the 800 ms supervision.md fixes; how often we look
    // inside it is ours.
    const settleMs = Number(process.env.YAN_GUARD_SETTLE ?? '0.8') * 1000;
    for (let waited = 0; waited < settleMs; waited += SETTLE_STEP_MS) {
      await sleep(SETTLE_STEP_MS);
      if (sup.healthy()) {
        sup.guardReset();
        return 0;
      }
      if (!takenBefore && sup.lockTaken()) {
        // Autoarm claimed the lock while we waited and has not written its
        // first beacon yet. That is a watcher starting, not one missing.
        return 0;
      }
    }

    const n = sup.guardBump();
    if (n > GUARD_BUDGET) return failOpen(io, n, task);
    // Exit 2 is Claude's blocking Stop: stderr is what the model reads.
    io.note(
      `yan guard: task ${task} still has live shifts and no healthy watcher (${why}). ` +
        `Attempt ${n} of ${GUARD_BUDGET}: run 'yan wait' or let the Stop autoarm hook arm one, then end the turn.`,
    );
    return 2;
  }

  // Codex's own one-shot, read only here: the Claude branch above has already
  // returned, and it never touches stdin.
  const payload = await io.stdin();
  if (payload !== '') {
    try {
      const parsed: unknown = JSON.parse(payload);
      if ((parsed as { stop_hook_active?: unknown }).stop_hook_active === true) return 0;
    } catch {
      // Not JSON, or half of it. No payload is the safe reading.
    }
  }

  const n = sup.guardBump();
  if (n > GUARD_BUDGET) return failOpen(io, n, task);
  // The command has to be one the model can paste and run, which is narrower
  // than it looks and was got wrong until a real codex ran this hook.
  //
  //   `yan` is not on path inside an agent's pane. Everything else yan writes
  //   for an agent to run names $YAN_HOME/bin/yan absolutely — a shift's brief
  //   does — and this line did not. The model dutifully ran `yan drain` and
  //   got "the term 'yan' is not recognized".
  //
  //   And the pane's shell is powershell on Windows (terminal.md §7), which
  //   does not understand `${VAR:-default}`. A default written that way is a
  //   parse error, not a default, so the number is written out.
  const yan = normalizePath(join(yanHome(), 'bin', 'yan'));
  io.say(
    JSON.stringify({
      decision: 'block',
      reason:
        `yan guard: task ${task} still has live shifts. Attempt ${n} of ${GUARD_BUDGET}: run ` +
        `'${yan}' wait --seconds ${checkpointSeconds()} for another checkpoint slice, then ` +
        `'${yan}' drain, before ending the turn.`,
    }),
  );
  return 0;
}

/** The Codex checkpoint slice, resolved here rather than left to a shell. */
function checkpointSeconds(): number {
  const configured = Number.parseInt(process.env.YAN_CODEX_CHECKPOINT ?? '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 180;
}

function failOpen(io: GuardIo, count: number, task: string): number {
  io.note(
    `yan guard: AUTOMATIC SUPERVISION IS BROKEN - ${count} attempts to arm a watcher for task ${task} have failed, so this turn is being let through.`,
  );
  io.note(
    `yan guard: nothing is watching the live shifts. Check them by hand with 'yan ls ${task}', or restart yan.`,
  );
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The harness payload, or nothing.
 *
 * bounded, never a plain read to EOF. A Stop hook that blocks on a pipe nobody
 * ever closes is a session that cannot end, which is the failure this whole
 * file is built to avoid. A harness that hands over a payload and closes hits
 * EOF immediately; anything else costs one second and is treated as no payload.
 */
export function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY === true) return Promise.resolve('');
  return new Promise<string>((resolve) => {
    let text = '';
    const done = (): void => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && /[\\/]turnend-guard\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  guard(process.argv.slice(2), {
    note: (line) => process.stderr.write(`${line.startsWith('yan guard:') ? line : `guard: ${line}`}\n`),
    say: (line) => process.stdout.write(`${line}\n`),
    stdin: () => readStdin(Number(process.env.YAN_GUARD_STDIN_TIMEOUT ?? '1') * 1000),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // A guard that crashes must not wedge the session either.
      process.stderr.write(`guard: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 0;
    });
}
