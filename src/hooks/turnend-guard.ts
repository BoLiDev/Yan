import { join } from 'node:path';
import { GUARD_BUDGET, Supervision } from '../records/supervision/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { normalizePath } from '../util/paths.js';

/**
 * The blocking Stop hook for both harnesses: may this turn end while shifts
 * are still live? Only the evidence differs.
 *
 * On Claude it blocks when a shift is live and no watcher is healthy, waiting
 * 800 ms first because both Stop hooks fire at once and autoarm may still be
 * claiming the lock. It never reads `stop_hook_active`, which Claude also sets
 * after a rewake — the very turn that needs a new watcher — and keeps its own
 * count in `run/guard-failures` instead.
 *
 * On Codex it blocks on live shifts alone: there is no autoarm and no watcher
 * between checkpoint slices, so a missing lock is the normal state. Codex's
 * `stop_hook_active` is honoured as a one-shot.
 *
 * It fails open after GUARD_BUDGET blocked attempts, with a loud warning: a
 * guard that can wedge a session is worse than no guard.
 */

export type Harness = 'claude' | 'codex';

export interface GuardIo {
  /** stderr: what the Claude model reads, and where a warning goes. */
  readonly note: (line: string) => void;
  /** stdout: the Codex decision object. */
  readonly say: (line: string) => void;
  /** The harness payload, read on the Codex path only. */
  readonly stdin: () => Promise<string>;
}

const SETTLE_STEP_MS = 100;

/**
 * The exit code the hook should use: 2 blocks a Claude turn with the reason on
 * stderr, 0 lets it end — carrying a `{"decision":"block",…}` object on stdout
 * when it is Codex's turn being blocked.
 */
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
    // Kept now, because every later predicate overwrites it.
    const why = sup.why() === '' ? 'no watcher on duty' : sup.why();

    const takenBefore = sup.lockTaken();

    // Polled rather than slept through, so a healthy turn pays milliseconds.
    const settleMs = Number(process.env.YAN_GUARD_SETTLE ?? '0.8') * 1000;
    for (let waited = 0; waited < settleMs; waited += SETTLE_STEP_MS) {
      await sleep(SETTLE_STEP_MS);
      if (sup.healthy()) {
        sup.guardReset();
        return 0;
      }
      if (!takenBefore && sup.lockTaken()) {
        // A lock claimed while we waited is a watcher starting up.
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
  if (n > GUARD_BUDGET) return failOpen(io, n, task);
  // The reason has to be pasteable in an agent's pane, where `yan` is not on
  // PATH and the shell may be PowerShell: an absolute path and a real number.
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

/** The Codex checkpoint slice, from `$YAN_CODEX_CHECKPOINT` or 180 seconds. */
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
