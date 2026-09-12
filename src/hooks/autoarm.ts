import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Supervision } from '../records/supervision/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';

/**
 * The Stop autoarm for the two harnesses that can hold a multi-hour hook:
 * Claude, with `asyncRewake: true` and a long timeout, and agy, whose Stop
 * hook blocks its loop synchronously for as long as its `timeout` allows.
 * Never Codex, which parses `async` but does not run asynchronous hooks.
 *
 *   nothing to supervise, or a watcher already on duty  -> exit 0, quiet
 *   otherwise run the long `yan wait` in this foreground
 *     something happened   -> exit 2, the reason on stderr, Claude rewakes yan
 *     nothing left to do   -> exit 0, quiet
 *
 * Agy is the same decision in a different envelope: it discards the exit code
 * and reads a decision object off stdout, so `--agy` speaks `continue` where
 * Claude exits 2, and says `stop` out loud on every quiet path rather than
 * leaving stdout empty.
 *
 * The watcher runs in the foreground, never backgrounded or detached, so the
 * harness owns its process group and it cannot outlive the session. A test
 * reads this file to check that stays true.
 *
 * Reads no stdin, and never blocks a turn: `turnend-guard.ts` is what notices
 * an autoarm that did not run at all.
 */

interface AutoarmIo {
  /** stderr: what the Claude model reads, and where a warning goes. */
  readonly note: (line: string) => void;
  /** stdout: agy's decision object, and nothing at all for Claude. */
  readonly say: (line: string) => void;
}

export function autoarm(argv: readonly string[], io: AutoarmIo): number {
  const agy = argv.includes('--agy');
  const positional = argv.filter((a) => !a.startsWith('-'));
  const task = positional[0] ?? process.env.YAN_TASK ?? '';

  /** Let the turn end. Agy is told so; Claude reads the exit code. */
  const quiet = (): number => {
    if (agy) io.say(JSON.stringify({ decision: 'stop' }));
    return 0;
  };
  /** Hold the turn open, with `reason` as the whole of what the model reads. */
  const hold = (reason: string): number => {
    if (agy) {
      io.say(JSON.stringify({ decision: 'continue', reason }));
      return 0;
    }
    io.note(reason);
    return 2;
  };

  if (task === '' || !Task.isId(task) || !new Task(task).exists()) return quiet();

  const sup = new Supervision(task);
  if (sup.liveCount() === 0) return quiet();
  if (sup.lockTaken()) return quiet();

  const home = yanHome();
  const yan = join(home, 'dist', 'cli', 'yan.js');
  if (!existsSync(yan)) {
    io.note(`cannot find ${yan} - run 'npm run build'; nothing is watching task ${task}`);
    return quiet();
  }

  // No --seconds: the unbounded shape. Its stdout is the reason, which becomes
  // the banner Claude shows the model.
  const watcher = spawnSync(process.execPath, [yan, 'wait', '--task', task], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, YAN_HOME: home },
    windowsHide: true,
  });

  if (watcher.error !== undefined) {
    io.note(`could not start the watcher: ${watcher.error.message}`);
    return quiet();
  }

  const reason = (watcher.stdout ?? '').trim();
  switch (watcher.status) {
    case 0:
      return hold(`${reason}\nrun 'yan drain' first, then handle it.`);
    case 3:
      // Every shift clocked out while we watched.
      return quiet();
    case 4:
      // Another watcher took the lock between the check and the start.
      return quiet();
    default:
      // Supervision did not start, and the turn is let through anyway.
      io.note(
        `'yan wait' exited ${String(watcher.status)} without arming supervision - 'yan ls ${task}' shows what is live`,
      );
      return quiet();
  }
}

const invokedDirectly = process.argv[1] !== undefined && /[\\/]autoarm\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = autoarm(process.argv.slice(2), {
    note: (line) => {
      process.stderr.write(`yan autoarm: ${line}\n`);
    },
    say: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
}
