import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cliKind } from './launch.js';

/**
 * The conversation a CLI last had in a directory, for a start there to go
 * on with it. claude keeps each as `<session id>.jsonl` in a folder named
 * for the directory it was started in, under `~/.claude/projects/` (or
 * `$CLAUDE_CONFIG_DIR`), and resumes one by its id. The other CLIs are
 * started afresh: none here is resumed by a name yan can find.
 */

/** How long a session folder's name may be before claude cuts it and ends it with a hash of the path. */
const NAME_MOST = 200;

/**
 * The folder claude keeps a directory's sessions in: the path with what is
 * not a letter or a digit made a dash, as claude's own code names it. One
 * too long to be a name is cut and ended with a hash of the whole path,
 * which is not worked out here: the folders that begin as it does are
 * taken, of which there is in practice one.
 */
function projectDirs(workdir: string): string[] {
  const root = join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects');
  const name = workdir.replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= NAME_MOST) return [join(root, name)];
  try {
    return readdirSync(root).filter((d) => d.startsWith(`${name.slice(0, NAME_MOST)}-`)).map((d) => join(root, d));
  } catch {
    return [];
  }
}

/**
 * The id of the session `cli` last had in `workdir`, when it was written
 * to at or after `since`, seconds since 1970: the moment from which the
 * directory has been this task's alone, so a conversation another task had
 * in the same directory before it is never taken up. Undefined when there
 * is none, or for a CLI yan does not resume.
 */
export function lastSession(cli: string, workdir: string, since: number): string | undefined {
  if (cliKind(cli) !== 'claude') return undefined;
  let newest: { id: string; at: number } | undefined;
  for (const dir of projectDirs(workdir)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
      let at: number;
      try {
        at = statSync(join(dir, name)).mtimeMs / 1000;
      } catch {
        continue;
      }
      if (at >= since && (newest === undefined || at > newest.at)) newest = { id: name.slice(0, -'.jsonl'.length), at };
    }
  }
  return newest?.id;
}
