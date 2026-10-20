import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which yan a `yan serve` is running, as a fingerprint of the files it runs
 * from: the build in dist/ and the page in templates/serve/. When it is not
 * the one the server started with, a newer yan was built or pulled into the
 * clone, and the server restarts on it rather than waiting for the user to.
 */

const PARTS = [['dist'], ['templates', 'serve']] as const;

/** Every file's path, size and modification time, hashed; '' when there is nothing to read. */
export function buildPrint(home: string): string {
  const hash = createHash('sha256');
  let any = false;
  for (const part of PARTS) {
    const dir = join(home, ...part);
    let names: string[];
    try {
      names = readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const s = statSync(join(dir, name));
        if (!s.isFile()) continue;
        hash.update(`${part.join('/')}/${name}\0${s.size}\0${s.mtimeMs}\n`);
        any = true;
      } catch {
        // Gone between the listing and the look: a build is under way, and the next tick sees it settled.
      }
    }
  }
  return any ? hash.digest('hex').slice(0, 16) : '';
}

/** Whether the build in `home` starts at all, so a broken one is never restarted onto. */
export function buildLoads(home: string): boolean {
  const r = spawnSync(process.execPath, [join(home, 'dist', 'cli', 'yan.js'), 'serve', '--help'], {
    stdio: 'ignore',
    timeout: 15_000,
    env: { ...process.env, YAN_HOME: home },
  });
  return r.status === 0;
}
