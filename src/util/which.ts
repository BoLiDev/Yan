import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a command is, or `undefined`. A name with a slash in it is a path and
 * is taken as it is; a bare name is looked for on `PATH`, honouring `PATHEXT`
 * on Windows so `gh` finds `gh.exe` and `claude` finds `claude.cmd`. Needs no
 * shell.
 */
export function which(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) return isFile(command) ? command : undefined;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}
