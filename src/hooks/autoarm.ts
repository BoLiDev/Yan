import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Supervision } from '../records/supervision/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';

/**
 * Claude's Stop autoarm, registered with `asyncRewake: true` and a long
 * timeout — never for Codex, which cannot hold a multi-hour hook.
 *
 *   nothing to supervise, or a watcher already on duty  -> exit 0, quiet
 *   otherwise run the long `yan wait` in this foreground
 *     something happened   -> exit 2, the reason on stderr, Claude rewakes yan
 *     nothing left to do   -> exit 0, quiet
 *
 * The watcher runs in the foreground, never backgrounded or detached, so the
 * harness owns its process group and it cannot outlive the session. A test
 * reads this file to check that stays true.
 *
 * Reads no stdin, and never blocks a turn: `turnend-guard.ts` is what notices
 * an autoarm that did not run at all.
 */

export function autoarm(argv: readonly string[], note: (line: string) => void): number {
  const task = argv[0] ?? process.env.YAN_TASK ?? '';

  if (task === '' || !Task.isId(task) || !new Task(task).exists()) return 0;

  const sup = new Supervision(task);
  if (sup.liveCount() === 0) return 0;
  if (sup.lockTaken()) return 0;

  const home = yanHome();
  const yan = join(home, 'dist', 'cli', 'yan.js');
  if (!existsSync(yan)) {
    note(`cannot find ${yan} - run 'npm run build'; nothing is watching task ${task}`);
    return 0;
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
    note(`could not start the watcher: ${watcher.error.message}`);
    return 0;
  }

  const reason = (watcher.stdout ?? '').trim();
  switch (watcher.status) {
    case 0:
      note(reason);
      note("run 'yan drain' first, then handle it.");
      return 2;
    case 3:
      // Every shift clocked out while we watched.
      return 0;
    case 4:
      // Another watcher took the lock between the check and the start.
      return 0;
    default:
      // Supervision did not start, and the turn is let through anyway.
      note(
        `'yan wait' exited ${String(watcher.status)} without arming supervision - 'yan ls ${task}' shows what is live`,
      );
      return 0;
  }
}

const invokedDirectly = process.argv[1] !== undefined && /[\\/]autoarm\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  process.exitCode = autoarm(process.argv.slice(2), (line) => {
    process.stderr.write(`yan autoarm: ${line}\n`);
  });
}
