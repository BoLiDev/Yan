import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Everything the prompts work out before they ask anything, and everything
 * they assemble after the last answer. Nothing here prompts, spawns or writes,
 * and nothing here invents a `target`.
 */

export interface RegisteredRepo {
  readonly name: string;
  readonly url: string;
  readonly dir: string;
}

/* The repositories are passed in: nothing here reads the registry. */

const WORKSPACE_MANIFESTS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json'];
const CONVENTIONAL_DIRS = ['packages', 'apps'];

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function childDirs(root: string, rel: string): string[] {
  const dir = join(root, rel);
  if (!isDir(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && n !== 'node_modules')
    .filter((n) => isDir(join(dir, n)))
    .map((n) => `${rel}/${n}`);
}

/**
 * The `- 'packages/*'` list items out of a `pnpm-workspace.yaml`, and nothing
 * else of YAML. A pattern this cannot read is skipped.
 */
function globsFromPnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
    if (m !== null) out.push((m[1] as string).trim());
  }
  return out;
}

function expandGlob(root: string, pattern: string): string[] {
  if (pattern.startsWith('!') || pattern === '.') return [];
  if (!pattern.includes('*')) {
    return isDir(join(root, pattern)) ? [pattern.replace(/\/$/, '')] : [];
  }
  // Only `<dir>/*` is expanded. `**` and mid-segment globs are left alone.
  const m = /^([^*]+)\/\*$/.exec(pattern);
  if (m === null) return [];
  return childDirs(root, (m[1] as string).replace(/\/$/, ''));
}

export interface Monorepo {
  readonly monorepo: boolean;
  readonly reasons: readonly string[];
  readonly packages: readonly string[];
}

/**
 * The workspace packages a repository declares, best effort — it only decides
 * which list to offer, and "the whole repository" is always among the choices.
 */
export function detectMonorepo(repoDir: string): Monorepo {
  const reasons: string[] = [];
  const packages = new Set<string>();

  for (const manifest of WORKSPACE_MANIFESTS) {
    const p = join(repoDir, manifest);
    if (!existsSync(p)) continue;
    reasons.push(manifest);
    if (!manifest.startsWith('pnpm-workspace')) continue;
    try {
      for (const g of globsFromPnpmWorkspace(readFileSync(p, 'utf8'))) {
        for (const d of expandGlob(repoDir, g)) packages.add(d);
      }
    } catch { /* unreadable is just a false negative */ }
  }

  const pkgJson = join(repoDir, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const parsed = JSON.parse(readFileSync(pkgJson, 'utf8')) as Record<string, unknown>;
      const workspaces = parsed.workspaces;
      const list = Array.isArray(workspaces)
        ? workspaces
        : typeof workspaces === 'object' && workspaces !== null &&
            Array.isArray((workspaces as Record<string, unknown>).packages)
          ? ((workspaces as Record<string, unknown>).packages as unknown[])
          : undefined;
      if (list !== undefined) {
        reasons.push('package.json workspaces');
        for (const g of list) {
          if (typeof g === 'string') for (const d of expandGlob(repoDir, g)) packages.add(d);
        }
      }
    } catch { /* unreadable is just a false negative */ }
  }

  for (const dir of CONVENTIONAL_DIRS) {
    if (!isDir(join(repoDir, dir))) continue;
    reasons.push(`${dir}/`);
    for (const d of childDirs(repoDir, dir)) packages.add(d);
  }

  return {
    monorepo: reasons.length > 0 && packages.size > 0,
    reasons: [...new Set(reasons)],
    packages: [...packages].sort(),
  };
}

/** The choice standing for the whole repository, whose scope is empty. */
export const WHOLE_REPO = '';

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/** The scope menu for one repository: its packages, and the whole repository. */
export function scopeChoices(detection: Monorepo): Choice[] {
  return [
    ...detection.packages.map((p) => ({ value: p, label: p })),
    { value: WHOLE_REPO, label: 'the whole repository', hint: 'no scope restriction' },
  ];
}

function sanitise(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'unit' : cleaned;
}

/** A readable unit name from a scope path, unique within this run. */
export function unitName(scopePath: string, repoName: string, used = new Set<string>()): string {
  const base = sanitise(scopePath === '' ? repoName : basename(scopePath));
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}`;
    n += 1;
  }
  used.add(name);
  return name;
}

export interface PlannedUnit {
  readonly repo: string;
  readonly unit: string;
  readonly scope: readonly string[];
  readonly target: string;
}

/**
 * The chosen scopes as units: one per selected package, or a single
 * whole-repository unit. Selecting the whole repository drops the rest.
 */
export function unitsForRepo(
  input: { repo: string; scopes: readonly string[]; target: string },
  used = new Set<string>(),
): PlannedUnit[] {
  const picked = input.scopes.length > 0 ? input.scopes : [WHOLE_REPO];
  // A unit that restricts nothing already contains every package beside it.
  const list = picked.includes(WHOLE_REPO) ? [WHOLE_REPO] : picked;
  return list.map((scope) => ({
    repo: input.repo,
    unit: unitName(scope, input.repo, used),
    scope: scope === WHOLE_REPO ? [] : [scope],
    target: input.target,
  }));
}
