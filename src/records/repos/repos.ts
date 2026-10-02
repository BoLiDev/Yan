import { join } from 'node:path';
import { editJson, initJson, readJsonIfPresent } from '../../util/json.js';
import { cloneOf, linkClone } from '../../util/machine.js';
import { asRecord, asString } from '../../util/narrow.js';
import { isRecordId } from '../../util/names.js';
import { isDirectory } from '../../util/paths.js';
import { repoKey } from '../../util/repo-key.js';
import { vaultDir } from '../../util/vault.js';
import { YanError } from '../../util/error.js';

/**
 * The repositories this context works in, in two halves:
 *
 *   <vault>/repos.json        { "version": 1, "repos": { "<name>": { "url": … } } }
 *   ~/.yan/config.json        "clones": { "<repoKey of url>": "<path>" }
 *
 * The vault's half travels with it; where each clone sits is this machine's,
 * kept where nothing commits it. "Registered but not linked here" is what a
 * freshly cloned vault looks like.
 */

export interface RepoEntry {
  readonly name: string;
  readonly url: string;
  /** This machine's clone, or `undefined` when nothing has said where it is. */
  readonly clone?: string;
}

export function reposPath(): string {
  return join(vaultDir(), 'repos.json');
}

function urls(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(asRecord(asRecord(readJsonIfPresent(reposPath())).repos))) {
    const url = asString(asRecord(value).url).trim();
    if (url !== '') out[name] = url;
  }
  return out;
}

/** Every registered repository, with this machine's clone where it has one, sorted by name. */
export function registry(): RepoEntry[] {
  const known = urls();
  return Object.keys(known)
    .sort()
    .map((name) => {
      const url = known[name] as string;
      const clone = cloneOf(repoKey(url));
      return { name, url, ...(clone === undefined ? {} : { clone }) };
    });
}

export function repoNamed(name: string): RepoEntry | undefined {
  return registry().find((r) => r.name === name);
}

/** The registered repository `url` names, in whichever spelling. */
export function repoWithUrl(url: string): RepoEntry | undefined {
  const key = repoKey(url);
  return registry().find((r) => repoKey(r.url) === key);
}

/** The clone of `url` on this machine when it is still there, registered or not. */
export function cloneFor(url: string): string | undefined {
  const clone = cloneOf(repoKey(url));
  return clone !== undefined && isDirectory(clone) ? clone : undefined;
}

/**
 * Register `url` under `name`, and say where its clone is on this machine.
 * A repository already registered keeps the name it has.
 *
 * @returns the name it is registered under.
 * @throws YanError `repo_usage` for an unusable name, `repo_conflict` when the
 *   name is taken by another repository.
 */
export function register(name: string, url: string, clone?: string): string {
  const already = repoWithUrl(url);
  if (already !== undefined) {
    if (clone !== undefined) linkClone(repoKey(url), clone);
    return already.name;
  }
  if (!isRecordId(name)) throw YanError.usage('repo_usage', `'${name}' is not a usable repository name - pass --name`);
  const taken = urls()[name];
  if (taken !== undefined && repoKey(taken) !== repoKey(url)) {
    throw new YanError('repo_conflict', `'${name}' is already registered as ${taken} - pass --name to register ${url} under another name`);
  }
  const file = reposPath();
  initJson(file, { version: 1, repos: {} });
  editJson(file, (raw) => {
    const doc = asRecord(raw);
    return { ...doc, repos: { ...asRecord(doc.repos), [name]: { url } } };
  });
  if (clone !== undefined) linkClone(repoKey(url), clone);
  return name;
}

/** Say where this machine's clone of a registered repository is. */
export function link(entry: RepoEntry, clone: string): void {
  linkClone(repoKey(entry.url), clone);
}

/** Take `name` out of the vault's half. This machine's clone, and where it is, are left alone. */
export function unregister(name: string): void {
  editJson(reposPath(), (raw) => {
    const doc = asRecord(raw);
    const repos = { ...asRecord(doc.repos) };
    delete repos[name];
    return { ...doc, repos };
  });
}
