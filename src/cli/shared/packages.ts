import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectory } from '../../util/paths.js';

/**
 * The workspace packages a repository declares, best effort: they are only
 * the choices a new task's scope is picked from, and "the whole repository"
 * is always among them. Nothing here prompts or writes.
 */

const WORKSPACE_MANIFESTS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml'];
const CONVENTIONAL_DIRS = ['packages', 'apps'];

function childDirs(root: string, rel: string): string[] {
  const dir = join(root, rel);
  if (!isDirectory(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && n !== 'node_modules')
    .filter((n) => isDirectory(join(dir, n)))
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
    return isDirectory(join(root, pattern)) ? [pattern.replace(/\/$/, '')] : [];
  }
  // Only `<dir>/*` is expanded. `**` and mid-segment globs are left alone.
  const m = /^([^*]+)\/\*$/.exec(pattern);
  if (m === null) return [];
  return childDirs(root, (m[1] as string).replace(/\/$/, ''));
}

/** `package.json`'s workspaces, as an array or as `{ packages }`. */
function npmWorkspaces(repoDir: string): unknown[] {
  const file = join(repoDir, 'package.json');
  if (!existsSync(file)) return [];
  try {
    const workspaces = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>).workspaces;
    if (Array.isArray(workspaces)) return workspaces;
    const packages = (workspaces as Record<string, unknown> | undefined)?.packages;
    return Array.isArray(packages) ? packages : [];
  } catch {
    return []; // unreadable is just a false negative
  }
}

/**
 * Paths relative to `repoDir`, sorted: what pnpm's workspace file and
 * package.json's workspaces name, and the directories under `packages/` and
 * `apps/`. Empty for a repository that is one package.
 */
export function workspacePackages(repoDir: string): string[] {
  const packages = new Set<string>();

  for (const manifest of WORKSPACE_MANIFESTS) {
    const file = join(repoDir, manifest);
    if (!existsSync(file)) continue;
    try {
      for (const g of globsFromPnpmWorkspace(readFileSync(file, 'utf8'))) {
        for (const d of expandGlob(repoDir, g)) packages.add(d);
      }
    } catch {
      // unreadable is just a false negative
    }
  }
  for (const g of npmWorkspaces(repoDir)) {
    if (typeof g === 'string') for (const d of expandGlob(repoDir, g)) packages.add(d);
  }
  for (const dir of CONVENTIONAL_DIRS) {
    for (const d of childDirs(repoDir, dir)) packages.add(d);
  }
  return [...packages].sort();
}
