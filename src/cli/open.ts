import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommandError } from './shared/errors.js';
import { nativePath } from '../util/paths.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';

/**
 * `yan open <id> [--artifacts]` — print a task directory's absolute path, and
 * open it in the platform's file manager where there is one. Exits 0 whenever
 * the directory exists, printed path and all.
 *
 * `$YAN_OPENER` overrides the opener; setting it empty means the path is the
 * whole answer.
 */

/** Run an opener; its exit code never becomes this command's. */
function openWith(cmd: string, path: string): void {
  // explorer.exe in particular returns 1 even when it succeeded.
  spawnSync(cmd, [path], { stdio: 'ignore', windowsHide: true });
}

function onPath(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  const r = spawnSync(probe, args, { stdio: 'ignore', windowsHide: true, shell: process.platform !== 'win32' });
  return r.status === 0;
}

export const command = new Command('open')
  .description('open a task directory, or its artifacts/')
  .argument('[task-id]')
  .option('--artifacts', 'open tasks/<id>/artifacts/ instead')
  .action(
    action('open', (id: string | undefined, options: { artifacts?: boolean }) => {
      if (id === undefined || id === '') {
        throw new CommandError('open', 'usage', 'a task id is required', { exitCode: 2 });
      }
      if (!Task.exists(id)) throw new CommandError('task', 'missing', `no such task: ${id}`);

      let dir = new Task(id).dir;
      if (options.artifacts === true) {
        dir = join(dir, 'artifacts');
        mkdirSync(dir, { recursive: true });
      }
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new CommandError('open', 'failed', `not a directory: ${dir}`);
      }

      out(dir);

      // Set but empty means "open with nothing", so it must not fall through.
      const override = process.env.YAN_OPENER;
      if (override !== undefined) {
        if (override !== '') openWith(override, dir);
        return;
      }

      if (process.platform === 'win32') {
        // Hand explorer.exe the Windows spelling of the path.
        if (onPath('explorer.exe')) openWith('explorer.exe', nativePath(dir));
        return;
      }
      for (const opener of ['xdg-open', 'wslview', 'explorer.exe']) {
        if (onPath(opener)) {
          openWith(opener, dir);
          return;
        }
      }
      // Nothing to open with: the path above is the answer.
    }),
  );
