import { join } from 'node:path';
import { GUARD_BUDGET, Supervision } from '../records/supervision/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { normalizePath } from '../util/paths.js';

/**
 * The blocking Stop hook for every harness: may this turn end while shifts
 * are still live? Only the evidence, and how the answer is spoken, differ.
 *
 * On Claude it blocks when a shift is live and no watcher is healthy, waiting
 * 800 ms first because both Stop hooks fire at once and autoarm may still be
 * claiming the lock. It never reads `stop_hook_active`, which Claude also sets
 * after a rewake — the very turn that needs a new watcher — and keeps its own
 * count in `run/guard-failures` instead.
 *
 * Agy weighs the same evidence as Claude, because it holds a multi-hour Stop
 * hook too and so a healthy watcher is its normal state as well. Only the
 * envelope changes: agy reads no exit code, so the answer is a decision object
 * on stdout and the model sees the `reason` field. `continue` is agy's word
 * for what Claude spells as exit 2, and every path that lets the turn end has
 * to say `stop` out loud — silence is not a documented answer.
 *
 * On Codex it blocks on live shifts alone: there is no autoarm and no watcher
 * between checkpoint slices, so a missing lock is the normal state. Codex's
 * `stop_hook_active` is honoured as a one-shot.
 *
 * It fails open after GUARD_BUDGET blocked attempts, with a loud warning: a
 * guard that can wedge a session is worse than no guard.
 *
 * It guards the main agent's turn and nobody else's. A shift working on the
 * yan repository inherits this repository's hook registrations, so its harness
 * fires this guard too; `YAN_SID`, which only a shift's environment carries,
 * is what tells that turn apart, and it is always let through.
 */

type Harness = 'claude' | 'codex' | 'agy';

interface GuardIo {
  /** stderr: what the Claude model reads, and where a warning goes. */
  readonly note: (line: string) => void;
  /** stdout: the Codex and agy decision objects. */
  readonly say: (line: string) => void;
  /** The harness payload, read on the Codex path only. */
  readonly stdin: () => Promise<string>;
}

const SETTLE_STEP_MS = 100;

/**
 * Let the turn end. Agy is told so in as many words; the other two read the
 * exit code, and a stray object on their stdout would be noise.
 */
function letThrough(harness: Harness, io: GuardIo): number {
  if (harness === 'agy') io.say(JSON.stringify({ decision: 'stop' }));
  return 0;
}

/**
 * The exit code the hook should use: 2 blocks a Claude turn with the reason on
 * stderr, 0 lets it end — carrying a `{"decision":"block",…}` object on stdout
 * when it is Codex's turn being blocked, or `{"decision":"continue",…}` when it
 * is agy's.
 */
export async function guard(argv: readonly string[], io: GuardIo): Promise<number> {
  let harness: Harness | undefined;
  let task = process.env.YAN_TASK ?? '';

  for (const arg of argv) {
    if (arg === '--claude' || arg === '--codex' || arg === '--agy') {
      harness = arg.slice(2) as Harness;
    } else if (arg === '-h' || arg === '--help') {
      io.say('usage: hook-turnend-guard.sh --claude | --codex | --agy [<task-id>]');
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
    io.note('say which harness this is - --claude, --codex or --agy');
    return 2;
  }

  // A shift's turn is never the main agent's to hold.
  if ((process.env.YAN_SID ?? '') !== '') return letThrough(harness, io);

  // A guard that cannot tell whose turn this is must not hold it hostage.
  if (task === '' || !Task.isId(task) || !new Task(task).exists()) {
    return letThrough(harness, io);
  }

  const sup = new Supervision(task);

  if (sup.liveCount() === 0) {
    sup.guardReset();
    return letThrough(harness, io);
  }

  // Claude and agy both run an autoarm, so both ask the same question: is a
  // watcher on duty? Codex has none, and falls through to the one-shot below.
  if (harness === 'claude' || harness === 'agy') {
    if (sup.healthy()) {
      sup.guardReset();
      return letThrough(harness, io);
    }
    // Kept now, because every later predicate overwrites it.
    const why = sup.why() === '' ? 'no watcher on duty' : sup.why();

    const takenBefore = sup.lockTaken();

    // Polled rather than slept through, so a healthy turn pays milliseconds.
    const settleMs = Number(process.env.YAN_GUARD_SETTLE ?? '0.8') * 1000;
    for (let waited = 0; waited < settleMs; waited += SETTLE_STEP_MS) {
      await sleep(SETTLE_STEP_MS);
      if (sup.healthy()) {
        sup.guardReset();
        return letThrough(harness, io);
      }
      if (!takenBefore && sup.lockTaken()) {
        // A lock claimed while we waited is a watcher starting up.
        return letThrough(harness, io);
      }
    }

    const n = sup.guardBump();
    if (n > GUARD_BUDGET) return failOpen(harness, io, n, task);
    const reason =
      `yan guard: task ${task} still has live shifts and no healthy watcher (${why}). ` +
      `Attempt ${n} of ${GUARD_BUDGET}: run 'yan wait' or let the Stop autoarm hook arm one, then end the turn.`;
    if (harness === 'agy') {
      // Agy discards the exit code; `reason` is the only thing the model sees.
      io.say(JSON.stringify({ decision: 'continue', reason }));
      return 0;
    }
    // Exit 2 is Claude's blocking Stop: stderr is what the model reads.
    io.note(reason);
    return 2;
  }

  // Codex's own one-shot; the Claude path above never touches stdin.
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
  if (n > GUARD_BUDGET) return failOpen(harness, io, n, task);
  // The reason has to be pasteable in an agent's pane, where `yan` is not on
  // PATH and the shell may be PowerShell: an absolute path and a real number.
  const yan = normalizePath(join(yanHome(), 'bin', 'yan'));
  io.say(
    JSON.stringify({
      decision: 'block',
      reason:
        `yan guard (${n}/${GUARD_BUDGET}): shifts are live. Run '${yan}' wait --seconds ${checkpointSeconds()} --drain, silently.`,
    }),
  );
  return 0;
}

/** The Codex checkpoint slice, from `$YAN_CODEX_CHECKPOINT` or 180 seconds. */
function checkpointSeconds(): number {
  const configured = Number.parseInt(process.env.YAN_CODEX_CHECKPOINT ?? '', 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 180;
}

function failOpen(harness: Harness, io: GuardIo, count: number, task: string): number {
  io.note(
    `yan guard: AUTOMATIC SUPERVISION IS BROKEN - ${count} attempts to arm a watcher for task ${task} have failed, so this turn is being let through.`,
  );
  io.note(
    `yan guard: nothing is watching the live shifts. Check them by hand with 'yan ls ${task}', or restart yan.`,
  );
  return letThrough(harness, io);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The harness payload, or `''` when none arrives within `timeoutMs` — never a
 * read to EOF, which a pipe nobody closes would block for ever.
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
