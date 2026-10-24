import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { asString } from '../../util/narrow.js';
import { branchOf, remoteUrl } from '../../util/git.js';
import { forgeOf, forgePage } from './forge.js';
import { readVaultConfig, vaultDir } from '../../util/vault.js';

/**
 * What a task's artifacts/ holds, for `yan context`. The opening prompt
 * gives each thing in it a folder, so the files are told apart by them:
 * design/ is what `user` will see, drawn before the work, docs/ is written
 * to be read, uat/ is what `user` checks the result by, misc/ is anything
 * else worth keeping. The rest is what sits loose beside them: the report,
 * and what a task from before these folders left there.
 */

export const ARTIFACT_GROUPS = ['design', 'docs', 'uat', 'misc', 'other'] as const;
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

/** The files of a task's artifacts/, design/ first, then docs/, uat/ and misc/, then the rest, each in path order. */
export function listArtifacts(taskDir: string): Artifact[] {
  const root = join(taskDir, 'artifacts');
  const all = filesUnder(root).map((file): Artifact => {
    const path = relative(root, file).split(sep).join('/');
    const top = path.split('/')[0];
    const group: ArtifactGroup = path.includes('/') && (top === 'design' || top === 'docs' || top === 'uat' || top === 'misc') ? top : 'other';
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
 * be filled in, with the forge's name when yan can tell it. The vault's
 * config.json `artifactLinks` says so when it is set, for a forge yan cannot
 * tell from its URL; otherwise it is the file's page on GitHub or GitLab.
 * `undefined` for any other.
 *
 * A template that is not an http(s) address is passed over: config.json
 * travels with the vault, and a link a report or a page opens must not be
 * able to run anything, as a `javascript:` one would.
 */
function linkTemplate(vault: string): FileLink | undefined {
  const configured = asString(readVaultConfig()?.artifactLinks).trim();
  if (/^https?:\/\//i.test(configured)) return { forge: null, template: configured };
  const url = remoteUrl(vault);
  const forge = url === undefined ? undefined : forgeOf(url);
  return forge === undefined ? undefined : { forge: forge.name, template: forgePage(forge, 'blob/{branch}/{path}') };
}

/** A web address for a file, `{path}` to be filled in, and the forge's name when yan can tell it. */
export interface FileLink {
  readonly forge: string | null;
  readonly template: string;
}

const encode = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/**
 * Where any file of `vault` is opened on its forge, on the branch the vault
 * is on: `{path}`, from the vault's root and encoded a part at a time, is
 * left to fill in. `yan serve` opens a file by it rather than by its own
 * copy, so the link can be passed on. It works once the vault is pushed.
 * `undefined` when there is no address to give.
 */
export function vaultFileLink(vault: string): FileLink | undefined {
  try {
    const link = linkTemplate(vault);
    const branch = branchOf(vault);
    if (link === undefined || branch === undefined) return undefined;
    return { forge: link.forge, template: link.template.replaceAll('{branch}', encode(branch)) };
  } catch {
    return undefined;
  }
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
    const link = vaultFileLink(vault);
    if (link === undefined) return undefined;
    const under = relative(vault, join(taskDir, 'artifacts')).split(sep).join('/');
    return (path) => link.template.replaceAll('{path}', encode(`${under}/${path}`));
  } catch {
    return undefined;
  }
}
