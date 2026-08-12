import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommandError } from './shared/errors.js';
import { nativePath } from '../util/paths.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';

/**
 * `yan open <id> [--artifacts]` — open a task directory, or its artifacts/.
 *
 * `artifacts/` is where a shift writes the things a person looks at — prototype
 * pages, screenshots, research data — because they belong to the project but
 * not to the work repository, and the leased worktree gets wiped
 * (memory.md §4.3). There is no index: the directory listing and the file names
 * are enough, so opening the directory is the whole feature.
 *
 * The absolute path is always printed, and on a machine with no graphical
 * opener that is the entire result and a perfectly good one. Printing the path
 * is never treated as a failure: this command exits 0 whenever the directory it
 * was asked for exists.
 *
 * `$YAN_OPENER` overrides the opener (a command that takes one path). That is
 * how the tests exercise both branches without a desktop.
 */

/** Run an opener, and never let its exit code decide this command's. */
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
        // yan may tidy artifacts/ but never changes what is in it (Appendix B).
        // Creating the directory so there is something to open is tidying.
        mkdirSync(dir, { recursive: true });
      }
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new CommandError('open', 'failed', `not a directory: ${dir}`);
      }

      out(dir);

      // Setting the variable at all is the decision, even to the empty string:
      // `YAN_OPENER=` means "open with nothing", which is how a test — or a
      // headless machine — says the path above is the whole answer. Falling
      // through to the platform opener because '' is falsy would spawn a real
      // window on every run and never close it.
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
      // Nothing to open with. The path above is the answer.
    }),
  );
