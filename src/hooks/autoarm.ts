import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Supervision } from '../records/supervision/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';

/**
 * Claude's Stop autoarm (supervision.md §4, architecture.md §6).
 *
 * Registered in `.claude/settings.json` with `asyncRewake: true` and a long
 * timeout. NOT registered for Codex, which parses `async` but does not run
 * asynchronous command hooks and therefore cannot hold a multi-hour watcher.
 *
 *   is there anything to supervise?   no  -> exit 0, quiet
 *   run the long `yan wait` IN THIS FOREGROUND
 *     something happened   -> exit 2, the reason on stderr, Claude rewakes yan
 *     nothing left to do   -> exit 0, quiet
 *
 * NEVER `&`. NEVER BACKGROUND. NEVER detached.
 *
 * The watcher runs in this hook's foreground so that THE HARNESS OWNS THE
 * PROCESS GROUP. A backgrounded watcher outlives the session that armed it,
 * survives the harness being killed, and is then a second watcher nobody can
 * see — the exact failure the single-flight lock exists to prevent, made
 * permanent. `spawnSync` is what says that here, and the test reads this file
 * to make sure it stays that way.
 *
 * This hook is why "the model forgot to start supervision" is not a possible
 * failure on the Claude path: the model never calls `yan wait`. What can still
 * fail is autoarm never running at all — broken settings, a skipped hook — and
 * only a second hook can notice that, which is what `turnend-guard.ts` is for.
 *
 * It does not read stdin. Nothing it decides depends on the harness's payload.
 */

export function autoarm(argv: readonly string[], note: (line: string) => void): number {
  const task = argv[0] ?? process.env.YAN_TASK ?? '';

  // A hook that cannot tell whose supervision this is has nothing to arm. It
  // gets out of the way rather than failing: a Stop hook that fails is a Stop
  // hook that blocks a turn.
  if (task === '' || !Task.isId(task) || !new Task(task).exists()) return 0;

  const sup = new Supervision(task);

  // Nothing to supervise: no shift is live, so there is nothing for a watcher
  // to see and no reason to hold a lock for hours.
  if (sup.liveCount() === 0) return 0;

  // Somebody is already on duty. Every Stop can fire autoarm, so this is the
  // normal case whenever a turn ends while a watcher is running.
  if (sup.lockTaken()) return 0;

  const home = yanHome();
  const yan = join(home, 'dist', 'cli', 'yan.js');
  if (!existsSync(yan)) {
    note(`cannot find ${yan} - run 'npm run build'; nothing is watching task ${task}`);
    return 0;
  }

  // No --seconds: this is the long shape. A checkpoint slice is the Codex path,
  // and a hook that armed one would report "nothing happened" every three
  // minutes. stdout is the reason, which becomes the banner Claude shows the
  // model; stderr flows through to ours.
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
      // Every shift clocked out while we watched. Nothing to wake anybody for.
      return 0;
    case 4:
      // Another watcher took the lock between our check and the start. Fine.
      return 0;
    default:
      // Supervision did not start. Do not block the turn over it — the turn-end
      // guard is what notices an unhealthy watcher, and it has a budget so a
      // broken watcher cannot wedge the session.
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
