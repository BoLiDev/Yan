import { spawnSync } from 'node:child_process';
import { nativePath } from '../../util/paths.js';

/**
 * Open a file or a directory the way a double click would, for `yan open` and
 * `yan ui`. Best effort: whether anything opened is never this command's exit
 * code, and with no opener the printed path is the answer.
 *
 * `$YAN_OPENER` overrides the platform's opener and may carry arguments
 * (`bash opener.sh`); set but empty, it means open with nothing.
 */

function onPath(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd];
  const r = spawnSync(probe, args, { stdio: 'ignore', windowsHide: true, shell: process.platform !== 'win32' });
  return r.status === 0;
}

/** Run an opener; its exit code is ignored. explorer.exe in particular returns 1 even when it succeeded. */
function openWith(cmd: string, path: string): void {
  spawnSync(cmd, [path], { stdio: 'ignore', windowsHide: true });
}

/** `$YAN_OPENER` is a command line: the path goes after it, quoted, and the shell splits the rest. */
function openWithOverride(command: string, path: string): void {
  if (process.platform === 'win32') {
    spawnSync(`${command} "${nativePath(path)}"`, { stdio: 'ignore', windowsHide: true, shell: true });
    return;
  }
  spawnSync('sh', ['-c', `${command} "$1"`, 'sh', path], { stdio: 'ignore' });
}

export function openPath(path: string): void {
  // Set but empty means "open with nothing", so it must not fall through.
  const override = process.env.YAN_OPENER;
  if (override !== undefined) {
    if (override !== '') openWithOverride(override, path);
    return;
  }

  if (process.platform === 'darwin') {
    openWith('open', path);
    return;
  }
  if (process.platform === 'win32') {
    // Hand explorer.exe the Windows spelling of the path.
    if (onPath('explorer.exe')) openWith('explorer.exe', nativePath(path));
    return;
  }
  for (const opener of ['xdg-open', 'wslview', 'explorer.exe']) {
    if (onPath(opener)) {
      openWith(opener, path);
      return;
    }
  }
}
