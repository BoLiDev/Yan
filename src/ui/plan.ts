import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Everything the prompts work out BEFORE they ask anything, and everything they
 * assemble AFTER the last answer (cli-ux.md §6, td cli-ux.md §3 and §5).
 *
 * Not one line of this module prompts, spawns, or writes. It is pure on
 * purpose: the interesting parts of the soft path — which packages a monorepo
 * offers, and how selections become units — are then testable without a
 * terminal, which is the one thing a test cannot conjure up.
 *
 * The rule it keeps is unchanged from the MVP's `ui/lib/plan.mjs`, which it
 * replaces: nothing here invents a `target`, nothing here writes `task.json`,
 * nothing here decides. It produces a list of choices.
 *
 * What HAS gone is the argv assembly. The MVP's soft path ended by running
 * `yan <cmd>` with a full set of flags, because it was a separate Node island
 * outside the shell. Commander and `resolve()` are that join now (cli-ux.md
 * §4): the answers go back into the action handler that asked for them, so
 * there is no second process and no command line to build.
 */

export interface RegisteredRepo {
  readonly name: string;
  readonly url: string;
  readonly dir: string;
}

/*
 * `readRepos` used to be here, reading `mem/repos.json` and assuming every
 * clone sat under `$YAN_HOME/repos/<name>`. Both halves of that are gone: the
 * registry lives in the vault and a clone is wherever this machine says it is
 * (v3 td repos.md). Resolving it needs the command layer, which is where the
 * caller now does it — `ui/` is given the answer rather than looking it up,
 * which is what "not one line of this module prompts, spawns, or writes"
 * always meant.
 */

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
 * `pnpm-workspace.yaml`, read the cheap way.
 *
 * cli-ux.md §5 asks for workspace package directories "when cheap to read", and
 * a YAML parser is not cheap: this picks up the `- 'packages/*'` list items and
 * nothing else. A pattern it cannot understand is skipped, which costs a false
 * negative at worst — and false negatives are acceptable there, because
 * `yan unit set --scope` can widen a scope later.
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
 * Best-effort monorepo detection (cli-ux.md §5).
 *
 * NEVER AUTHORITATIVE: it only decides which list to show, and "the whole
 * repository" is always one of the choices, so a wrong guess costs a keystroke.
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

/**
 * The whole repository is the EMPTY scope, not `"."`.
 *
 * `scope` is a list of path prefixes, and the prefix that matches every path is
 * no prefix at all, so an empty scope means the unit restricts nothing.
 */
export const WHOLE_REPO = '';

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * The scope menu for one repository.
 *
 * THE ESCAPE IS ALWAYS THERE: cli-ux.md §5 accepts a noisy list only as long as
 * "the whole repository" remains one of the choices.
 */
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
 * Selections become units (cli-ux.md §5, branching.md §6.4/§6.7).
 *
 *   one selected package  → one unit, scope = that path
 *   several packages      → several units in the same run, one per package;
 *                           one unit is one sub-application is one branch is
 *                           one tree, and the size of a unit is the size of one
 *                           outbound MR
 *   not a monorepo        → one unit whose scope is the repo root
 */
export function unitsForRepo(
  input: { repo: string; scopes: readonly string[]; target: string },
  used = new Set<string>(),
): PlannedUnit[] {
  const picked = input.scopes.length > 0 ? input.scopes : [WHOLE_REPO];
  // "The whole repository" swallows the rest: a unit that restricts nothing
  // already contains every package that could have been listed beside it.
  const list = picked.includes(WHOLE_REPO) ? [WHOLE_REPO] : picked;
  return list.map((scope) => ({
    repo: input.repo,
    unit: unitName(scope, input.repo, used),
    scope: scope === WHOLE_REPO ? [] : [scope],
    target: input.target,
  }));
}
