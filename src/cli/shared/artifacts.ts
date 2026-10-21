import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { asString } from '../../util/narrow.js';
import { branchOf, remoteUrl } from '../../util/git.js';
import { repoKey } from '../../util/repo-key.js';
import { readVaultConfig, vaultDir } from '../../util/vault.js';

/**
 * What a task's artifacts/ holds, for `yan context`. The opening prompt
 * gives two folders their own moment, so the files are told apart by them:
 * design/ is written before the work, uat/ is what `user` checks it by, and
 * anything else is the work's own.
 */

export const ARTIFACT_GROUPS = ['design', 'uat', 'other'] as const;
export type ArtifactGroup = (typeof ARTIFACT_GROUPS)[number];

export interface Artifact {
  readonly group: ArtifactGroup;
  /** Under artifacts/, with forward slashes. */
  readonly path: string;
  readonly bytes: number;
  /** ISO 8601, when it was last written. */
  readonly modifiedAt: string;
}

/** Every file under `dir`, dotfiles and dot-folders left out; [] when there is no such folder. */
function filesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

/** The files of a task's artifacts/, design/ first, then uat/, then the rest, each in path order. */
export function listArtifacts(taskDir: string): Artifact[] {
  const root = join(taskDir, 'artifacts');
  const all = filesUnder(root).map((file): Artifact => {
    const path = relative(root, file).split(sep).join('/');
    const top = path.split('/')[0];
    const group: ArtifactGroup = path.includes('/') && (top === 'design' || top === 'uat') ? top : 'other';
    const stat = statSync(file);
    return { group, path, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  });
  return ARTIFACT_GROUPS.flatMap((g) => all.filter((a) => a.group === g));
}

/**
 * One line per entry at the top of each group, a folder as its file count:
 * a task can hold hundreds of files, and the agent opens the folder for the
 * rest. A group past `limit` entries says how many more there are.
 */
export function artifactLines(artifacts: readonly Artifact[], limit = 20): string[] {
  const lines: string[] = [];
  for (const group of ARTIFACT_GROUPS) {
    const inGroup = artifacts.filter((a) => a.group === group);
    if (inGroup.length === 0) continue;
    const counts = new Map<string, number>();
    for (const a of inGroup) {
      const rest = group === 'other' ? a.path : a.path.slice(group.length + 1);
      const slash = rest.indexOf('/');
      const entry = slash === -1 ? rest : `${rest.slice(0, slash)}/`;
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    }
    const entries = [...counts].map(([entry, n]) => (entry.endsWith('/') ? `${entry}  ${n} file${n === 1 ? '' : 's'}` : entry));
    const shown = entries.length > limit ? [...entries.slice(0, limit), `… and ${entries.length - limit} more`] : entries;
    const label = (group === 'other' ? 'other' : `${group}/`).padEnd('design/'.length);
    shown.forEach((e, i) => lines.push(`  ${i === 0 ? label : ' '.repeat(label.length)}  ${e}`));
  }
  return lines;
}

/**
 * How a file of the vault is opened on its forge, `{branch}` and `{path}` to
 * be filled in. The vault's config.json `artifactLinks` says so when it is
 * set, for a forge yan cannot tell from its URL. Otherwise github.com is
 * `/blob/`, and a host with gitlab in its name, which is how most
 * self-hosted ones are called, `/-/blob/`. `undefined` for any other.
 *
 * A template that is not an http(s) address is passed over: config.json
 * travels with the vault, and a link a report or a page opens must not be
 * able to run anything, as a `javascript:` one would.
 */
function linkTemplate(vault: string): string | undefined {
  const configured = asString(readVaultConfig()?.artifactLinks).trim();
  if (/^https?:\/\//i.test(configured)) return configured;
  const url = remoteUrl(vault);
  if (url === undefined) return undefined;
  const key = repoKey(url);
  const host = key.split('/')[0] ?? '';
  if (host === 'github.com') return `https://${key}/blob/{branch}/{path}`;
  if (host.includes('gitlab')) return `https://${key}/-/blob/{branch}/{path}`;
  return undefined;
}

/**
 * A function giving the web address of a file of `taskDir`'s artifacts/ in
 * the vault's repository, on the branch the vault is on: what a report links
 * a recording by, since it is too large to put inside. The address works
 * once the vault is pushed. `undefined` when there is no address to give.
 */
export function artifactLinker(taskDir: string): ((path: string) => string) | undefined {
  try {
    const vault = vaultDir();
    const template = linkTemplate(vault);
    const branch = branchOf(vault);
    if (template === undefined || branch === undefined) return undefined;
    const under = relative(vault, join(taskDir, 'artifacts')).split(sep).join('/');
    const encode = (p: string): string => p.split('/').map(encodeURIComponent).join('/');
    return (path) => template.replaceAll('{branch}', encode(branch)).replaceAll('{path}', encode(`${under}/${path}`));
  } catch {
    return undefined;
  }
}
