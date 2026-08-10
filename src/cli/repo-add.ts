import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommandError } from './support/errors.js';
import { clone, remoteUrl } from '../util/git.js';
import { yanHome } from '../util/home.js';
import { editJson, initJson, readJson } from '../util/json.js';
import { samePath } from '../util/paths.js';
import { action, out } from './support/action.js';

/**
 * `yan repo-add <url>` — register a repository and clone it into `repos/`.
 *
 * THIS COMMAND IS THE ONLY WRITER OF `mem/repos.json` (Appendix A, Appendix B).
 * Nothing else may create, edit or delete that file. The registry has one owner
 * because it has one point of truth for "which repositories does this machine
 * know about", and design principle 2 says one owner per piece of information.
 *
 * Registry shape (Appendix D): an object keyed by repository name, alongside
 * the mandatory `version` field.
 *
 *   { "version": 1,
 *     "monorepo-x": { "url": "…", "mode_default": "mr", "pool_size": 8 } }
 *
 * Two behaviours worth stating up front:
 *
 *   * Idempotent. Re-adding a repository never clobbers a `mode_default` or
 *     `pool_size` that user has tuned. Only an explicit flag changes them.
 *   * It never re-clones over an existing clone. If `repos/<name>` is already a
 *     clone of the same URL the clone step is skipped; if it is anything else
 *     the command refuses rather than deleting and retrying.
 */

const MODE_DEFAULT = 'mr'; // delivery.md §8.2
const POOL_SIZE = 8; // worktree.md §7

/**
 * Handles both spellings a forge hands out:
 *   git@host:org/name.git      ssh://git@host:22/org/name.git
 *   https://host/org/name.git  https://host/org/name/
 */
export function repoNameFromUrl(url: string): string {
  let u = url.replace(/\/+$/, '');
  u = u.replace(/\.git$/, '');
  const lastSlash = u.slice(u.lastIndexOf('/') + 1);
  return lastSlash.slice(lastSlash.lastIndexOf(':') + 1);
}

/**
 * Two URLs naming the same repository.
 *
 * A local path we built and a local path git printed back can differ in
 * spelling on Windows, so those go through `normalizePath` (conventions §3).
 * Remote URLs (`git@…`, `https://…`) have no such problem and are compared
 * verbatim.
 */
export function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  const isLocal = (s: string): boolean => /^([/\\]|[A-Za-z]:[\\/])/.test(s);
  if (!isLocal(a) || !isLocal(b)) return false;
  return samePath(a, b);
}

export const command = new Command('repo-add')
  .description('register a repository and clone it into repos/')
  .argument('[url]')
  .option('--name <name>', 'register under this name instead of one derived from the URL')
  .option('--mode-default <mode>', 'scout | branch | mr')
  .option('--pool-size <n>', 'how many worktrees this repository may lease at once')
  .action(
    action(
      'repo-add',
      (
        url: string | undefined,
        options: { name?: string; modeDefault?: string; poolSize?: string },
      ) => {
        if (url === undefined || url === '') {
          throw CommandError.usage('repo', 'a clone URL is required');
        }

        const name = options.name && options.name !== '' ? options.name : repoNameFromUrl(url);
        if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
          throw CommandError.usage('repo', `cannot derive a usable repository name from '${url}' - pass --name`,
          );
        }
        if (name === 'version') {
          // The registry keeps repositories at the top level beside `version`
          // (Appendix D), so that one name is not available.
          throw CommandError.usage('repo', "'version' is not a usable repository name - pass --name");
        }

        const mode = options.modeDefault ?? '';
        if (mode !== '' && !['scout', 'branch', 'mr'].includes(mode)) {
          throw CommandError.usage('repo', `invalid --mode-default '${mode}' - one of: scout branch mr`,
          );
        }

        const pool = options.poolSize ?? '';
        if (pool !== '' && (!/^[0-9]+$/.test(pool) || Number(pool) <= 0)) {
          throw CommandError.usage('repo', `invalid --pool-size '${pool}' - a positive integer`);
        }

        const home = yanHome();
        const registry = join(home, 'mem', 'repos.json');
        const reposDir = join(home, 'repos');
        mkdirSync(reposDir, { recursive: true });
        mkdirSync(join(home, 'mem'), { recursive: true });
        initJson(registry, { version: 1 });

        const current = readJson(registry) as Record<string, unknown>;
        const entry = (
          typeof current[name] === 'object' && current[name] !== null ? current[name] : {}
        ) as Record<string, unknown>;
        const registeredUrl = typeof entry.url === 'string' ? entry.url : '';

        if (registeredUrl !== '' && !sameUrl(registeredUrl, url)) {
          throw new CommandError('repo', 'conflict', `'${name}' is already registered as ${registeredUrl} - pass --name to register ${url} under a different name`,
          );
        }

        const dest = join(reposDir, name);
        if (existsSync(dest)) {
          const existing = remoteUrl(dest) ?? '';
          if (!sameUrl(existing, url)) {
            throw new CommandError('repo', 'conflict', `${dest} already exists and is not a clone of ${url} (origin: ${existing === '' ? 'none' : existing}) - move it aside first; repo-add never clones over an existing directory`,
            );
          }
          out(`repo-add: ${dest} already exists, keeping it (no re-clone)`);
        } else {
          out(`repo-add: cloning ${url} into ${dest}`);
          if (clone(reposDir, url, name).code !== 0) {
            throw new CommandError('repo', 'clone_failed', `clone failed: ${url}`);
          }
        }

        // Write the registry last, and only ever merge: an entry that is
        // already there keeps every field it has unless a flag was passed.
        editJson(registry, (raw) => {
          const reg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
            string,
            unknown
          >;
          const before = (
            typeof reg[name] === 'object' && reg[name] !== null ? reg[name] : {}
          ) as Record<string, unknown>;
          reg[name] = {
            ...before,
            url,
            mode_default: mode !== '' ? mode : (before.mode_default ?? MODE_DEFAULT),
            pool_size: pool !== '' ? Number(pool) : (before.pool_size ?? POOL_SIZE),
          };
          return reg;
        });

        const after = (readJson(registry) as Record<string, unknown>)[name] as Record<
          string,
          unknown
        >;
        out(
          `repo-add: ${name}  url=${String(after.url)}  mode_default=${String(after.mode_default)}  pool_size=${String(after.pool_size)}`,
        );
      },
    ),
  );
