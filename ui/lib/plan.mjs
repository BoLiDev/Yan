// plan.mjs - everything the soft path works out BEFORE it asks anything, and
// everything it assembles AFTER the last answer (td cli-ux.md §3 and §5).
//
// Not one line of this module prompts, spawns, or writes. It is pure on
// purpose: the interesting parts of the soft path - which packages a monorepo
// offers, how selections become units, and the exact argv handed to `yan` -
// are then testable without a terminal, which is the one thing a test cannot
// conjure up (cli-ux.md §1: the soft path needs a real TTY, so what a test can
// prove is the ARGUMENT ASSEMBLY around it).
//
// The rule this file keeps: yan's scripts still do all the work. Nothing here
// invents a `target`, nothing here writes task.json, nothing here decides. It
// produces a list of choices and, at the end, a command line.

import fs from 'node:fs';
import path from 'node:path';

/** Repositories `user` may involve: mem/repos.json, which `yan repo-add` owns. */
export function readRepos(yanHome) {
  const file = path.join(yanHome, 'mem', 'repos.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return Object.keys(raw)
    .filter((name) => name !== 'version' && raw[name] && typeof raw[name] === 'object')
    .sort()
    .map((name) => ({
      name,
      url: raw[name].url ?? '',
      modeDefault: raw[name].mode_default ?? 'mr',
      dir: path.join(yanHome, 'repos', name),
    }));
}

const WORKSPACE_MANIFESTS = ['pnpm-workspace.yaml', 'pnpm-workspace.yml', 'lerna.json'];
const CONVENTIONAL_DIRS = ['packages', 'apps'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function childDirs(root, rel) {
  const dir = path.join(root, rel);
  if (!isDir(dir)) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && n !== 'node_modules')
    .filter((n) => isDir(path.join(dir, n)))
    .map((n) => `${rel}/${n}`);
}

// pnpm-workspace.yaml, read the cheap way. cli-ux.md §5 asks for workspace
// package dirs "when cheap to read", and a YAML parser is not cheap: this
// picks up the `- 'packages/*'` list items and nothing else. A pattern it
// cannot understand is skipped, which costs a false negative at worst, and
// cli-ux.md §5 says false negatives are acceptable because `yan unit set` can
// widen scope later.
function globsFromPnpmWorkspace(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function expandGlob(root, pattern) {
  if (pattern.startsWith('!') || pattern === '.') return [];
  const star = pattern.indexOf('*');
  if (star === -1) return isDir(path.join(root, pattern)) ? [pattern.replace(/\/$/, '')] : [];
  // Only `<dir>/*` is expanded. `**` and mid-segment globs are left alone.
  const m = /^([^*]+)\/\*$/.exec(pattern);
  if (!m) return [];
  return childDirs(root, m[1].replace(/\/$/, ''));
}

/**
 * Best-effort monorepo detection (cli-ux.md §5). Never authoritative: it only
 * decides which list to show, and "the whole repository" is always one of the
 * choices, so a wrong guess costs a keystroke.
 */
export function detectMonorepo(repoDir) {
  const reasons = [];
  const packages = new Set();

  for (const manifest of WORKSPACE_MANIFESTS) {
    const p = path.join(repoDir, manifest);
    if (fs.existsSync(p)) {
      reasons.push(manifest);
      if (manifest.startsWith('pnpm-workspace')) {
        try {
          for (const g of globsFromPnpmWorkspace(fs.readFileSync(p, 'utf8'))) {
            for (const d of expandGlob(repoDir, g)) packages.add(d);
          }
        } catch {
          /* unreadable is just a false negative */
        }
      }
    }
  }

  const pkgJson = path.join(repoDir, 'package.json');
  if (fs.existsSync(pkgJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      const ws = Array.isArray(parsed.workspaces) ? parsed.workspaces : parsed.workspaces?.packages;
      if (Array.isArray(ws)) {
        reasons.push('package.json workspaces');
        for (const g of ws) for (const d of expandGlob(repoDir, g)) packages.add(d);
      }
    } catch {
      /* unreadable is just a false negative */
    }
  }

  for (const dir of CONVENTIONAL_DIRS) {
    if (isDir(path.join(repoDir, dir))) {
      reasons.push(`${dir}/`);
      for (const d of childDirs(repoDir, dir)) packages.add(d);
    }
  }

  return {
    monorepo: reasons.length > 0 && packages.size > 0,
    reasons: [...new Set(reasons)],
    packages: [...packages].sort(),
  };
}

export const WHOLE_REPO = '';

/**
 * The scope menu for one repository. THE ESCAPE IS ALWAYS THERE: cli-ux.md §5
 * accepts a noisy list only as long as "the whole repository" remains one of
 * the choices.
 *
 * The whole repository is the empty scope, not the string ".": `scope` is a
 * list of path prefixes, and the prefix that matches every path is no prefix
 * at all. `yan scope-check` already reads an empty scope as "this unit
 * restricts nothing".
 */
export function scopeChoices(detection) {
  const choices = detection.packages.map((p) => ({ value: p, label: p }));
  choices.push({
    value: WHOLE_REPO,
    label: 'the whole repository',
    hint: 'no scope restriction',
  });
  return choices;
}

function sanitiseUnitName(raw) {
  const cleaned = String(raw)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'unit';
}

/** A readable unit name from a scope path, unique within this run. */
export function unitName(scopePath, repoName, used = new Set()) {
  const base = sanitiseUnitName(scopePath ? path.basename(scopePath) : repoName);
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}

/**
 * Selections become units (cli-ux.md §5, branching.md §6.4/§6.7).
 *
 *   one selected package  -> one unit, scope = that path
 *   several packages      -> several units in the same run, one per package;
 *                            one unit is one sub-application is one branch is
 *                            one tree, and the size of a unit is the size of
 *                            one outbound MR
 *   not a monorepo        -> one unit whose scope is the repo root
 */
export function unitsForRepo({ repo, scopes, target, mode }, used = new Set()) {
  const picked = scopes && scopes.length ? scopes : [WHOLE_REPO];
  // "the whole repository" swallows the rest: a unit that restricts nothing
  // already contains every package that could have been listed beside it.
  const list = picked.includes(WHOLE_REPO) ? [WHOLE_REPO] : picked;
  return list.map((scope) => ({
    repo,
    unit: unitName(scope, repo, used),
    scope: scope ? [scope] : [],
    target,
    ...(mode ? { mode } : {}),
  }));
}

function requireValue(value, what) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`the soft path collected no ${what}, so there is nothing to run`);
  }
}

/**
 * The command line. This is the whole contract between `ui/` and the rest of
 * yan: answers in, `yan <cmd> --flags` out, and the scripts do everything
 * else (architecture.md §2).
 *
 * The unit flags are ORDER SENSITIVE and that is the grammar bin/yan-task-new.sh
 * documents: each --repo opens a unit, and --unit / --scope / --target / --mode
 * / --needs bind to the --repo before them.
 */
export function buildTaskNewArgs({ id, title, description, units, agent }) {
  requireValue(title, 'title');
  if (!units || units.length === 0) throw new Error('at least one repository has to be involved');

  const argv = ['task', 'new'];
  if (id) argv.push('--id', id);
  argv.push('--title', title);
  if (description) argv.push('--description', description);

  for (const u of units) {
    requireValue(u.repo, 'repository');
    requireValue(u.target, 'target');
    argv.push('--repo', u.repo);
    if (u.unit) argv.push('--unit', u.unit);
    for (const s of u.scope ?? []) argv.push('--scope', s);
    argv.push('--target', u.target);
    if (u.mode) argv.push('--mode', u.mode);
    for (const n of u.needs ?? []) argv.push('--needs', n);
  }

  if (agent) argv.push('--agent', agent);
  return argv;
}

export function buildContinueArgs({ task, agent }) {
  requireValue(task, 'task id');
  const argv = ['continue', '--task', task];
  if (agent) argv.push('--agent', agent);
  return argv;
}

/** Incomplete tasks, from `yan ls --json`. The soft path never scans tasks/ itself. */
export function incompleteTasks(lsJson) {
  const tasks = Array.isArray(lsJson?.tasks) ? lsJson.tasks : [];
  return tasks.filter((t) => !t.complete);
}
