#!/usr/bin/env node
//
// One-off: move a machine from yan v3 to v4. Run it once per machine, after
// pulling the v4 code and before the first v4 command.
//
//   node scripts/migrate-v4.mjs              every vault registered here, the
//                                            worktree pool, ~/.yan/config.json
//   node scripts/migrate-v4.mjs --dry-run    say what would change, change nothing
//   node scripts/migrate-v4.mjs --vault <dir>   only this vault (repeatable)
//   node scripts/migrate-v4.mjs --skip-trees    leave the pool where it is
//
// A vault is a git repository shared between machines: migrate it on one,
// `yan vault push`, and on the others pull it (plain `git pull`) before running
// this. A vault already at version 2 is skipped, so the second machine only
// moves its pool and cleans its machine config.
//
// What changes, per vault (version 1 → 2):
//   tasks/<id>/task.json      v2: state, repo URL, deliverables folded in
//   tasks/<id>/deliverable.json   removed, its content now in task.json
//   tasks/<id>/brief.md       the `# <id> <title>` line removed
//   tasks/<id>/artifacts/drafts/  moved to tasks/<id>/drafts/
//   tasks/<id>/run/, shifts/*/run/, .enter.lock   removed (throwaway runtime)
//   mem/learnings/            moved to learnings/
//   config.json               { cli, model, effort } from agents.yan
//   repos.json, .local/, skills/, hooks/, mem/   removed
//   .gitignore, vault.json    rewritten; vault.json last, so an interrupted run
//                             can simply be run again
//
// And per machine:
//   ~/.yan-trees/             moved to ~/.yan/trees/ (a rename: nothing is
//                             copied when both are on one disk), git's links
//                             repaired, leases rewritten to hold a task id
//   ~/.yan/config.json        clone_root dropped
//
// Nothing is committed: review with `git -C <vault> status`, then
// `yan vault push`. Exit 0 when everything migrated, 1 when something needs a
// look (listed at the end), 2 when called wrongly.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// --------------------------------------------------------------- arguments --

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipTrees = args.includes('--skip-trees');
const onlyVaults = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--vault' && args[i + 1] !== undefined) onlyVaults.push(resolve(args[(i += 1)]));
  else if (!['--dry-run', '--skip-trees'].includes(a)) {
    process.stderr.write(`migrate-v4: unknown argument '${a}' - see the top of ${process.argv[1]}\n`);
    process.exit(2);
  }
}

const machineDir = process.env.YAN_MACHINE_DIR || join(homedir(), '.yan');
const oldPoolRoot = process.env.YAN_OLD_POOL_ROOT || join(homedir(), '.yan-trees');
const newPoolRoot = process.env.YAN_POOL_ROOT || join(machineDir, 'trees');

/** Things a person has to look at, printed at the end. */
const attention = [];
const said = (line) => process.stdout.write(`${line}\n`);
const look = (line) => attention.push(line);

// ---------------------------------------------------------------- progress --

/**
 * A bar on stderr when it is a terminal; otherwise a line at every tenth, so
 * a log of the run still shows it moving.
 */
function progress(label, total) {
  const tty = process.stderr.isTTY === true;
  const width = 28;
  let n = 0;
  let lastTenth = -1;
  const draw = (note) => {
    const share = total === 0 ? 1 : n / total;
    if (tty) {
      const filled = Math.round(share * width);
      const cols = process.stderr.columns || 100;
      const line = `${label} [${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${n}/${total}  ${note}`;
      process.stderr.write(`\r\x1b[2K${line.slice(0, cols - 1)}`);
    } else {
      const tenth = Math.floor(share * 10);
      if (tenth !== lastTenth) {
        lastTenth = tenth;
        process.stderr.write(`${label} ${n}/${total}\n`);
      }
    }
  };
  draw('');
  return {
    tick(note = '') {
      n += 1;
      draw(note);
    },
    done() {
      if (tty) process.stderr.write('\r\x1b[2K');
      said(`${label}: ${total} done`);
    },
  };
}

// ----------------------------------------------------------------- helpers --

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function writeJson(file, value) {
  if (dryRun) return;
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function remove(path) {
  if (!dryRun) rmSync(path, { recursive: true, force: true });
}

function git(dir, gitArgs) {
  const r = spawnSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/** Move a directory; merge into an existing one file by file. */
function moveDir(from, to) {
  if (dryRun) return;
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return;
  }
  for (const name of listDir(from)) {
    if (existsSync(join(to, name))) look(`${to}/${name} already exists - ${join(from, name)} was left where it is`);
    else renameSync(join(from, name), join(to, name));
  }
  if (listDir(from).length === 0) rmSync(from, { recursive: true, force: true });
}

// ------------------------------------------------------------------ vaults --

/** Which vaults to migrate: the ones named, or every one registered here. */
function vaultsToMigrate() {
  if (onlyVaults.length > 0) return onlyVaults;
  try {
    return Object.values(readJson(join(machineDir, 'config.json')).vaults ?? {}).map((p) => resolve(p));
  } catch {
    return [];
  }
}

/** When each task.json was first committed, from one `git log` over the vault. */
function firstCommitDays(vault) {
  const r = git(vault, ['log', '--diff-filter=A', '--format=%x00%aI', '--name-only', '--', 'tasks']);
  const found = new Map();
  if (r.code !== 0) return found;
  let when = '';
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\u0000')) when = line.slice(1).trim();
    else if (/^tasks\/[^/]+\/task\.json$/.test(line.trim())) found.set(line.trim().split('/')[1], when);
  }
  return found;
}

/** The URL a v3 unit's `repo` names: the registry's, a clone's origin, or the name itself. */
function repoUrl(vault, name, registry) {
  const entry = registry[name];
  if (entry !== null && typeof entry === 'object' && typeof entry.url === 'string' && entry.url !== '') return entry.url;
  if (isDir(name)) {
    const r = git(name, ['remote', 'get-url', 'origin']);
    if (r.code === 0 && r.stdout.trim() !== '') return r.stdout.trim();
  }
  return name;
}

/** A v3 deliverable.json as v4's list, or a reason it cannot be one. */
function deliverablesOf(raw) {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.deliverables)) return { problem: 'no deliverables array' };
  const out = [];
  const seen = new Set();
  for (const d of raw.deliverables) {
    if (d === null || typeof d !== 'object' || typeof d.id !== 'string' || typeof d.text !== 'string') return { problem: 'an entry with no id or text' };
    if (seen.has(d.id)) return { problem: `two entries share ${d.id}` };
    seen.add(d.id);
    if (d.status === 'todo') out.push({ id: d.id, text: d.text, status: 'todo' });
    else if (d.status === 'done' && typeof d.doneAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.doneAt)) {
      const refs = Array.isArray(d.refs) ? d.refs.filter((r) => typeof r === 'string' && r !== '') : [];
      out.push({ id: d.id, text: d.text, status: 'done', doneAt: d.doneAt, ...(refs.length > 0 ? { refs } : {}) });
    } else if (d.status === 'abandoned' && typeof d.reason === 'string' && d.reason.trim() !== '') {
      out.push({ id: d.id, text: d.text, status: 'abandoned', reason: d.reason });
    } else return { problem: `${d.id} has status ${JSON.stringify(d.status)} or lacks its date or reason` };
  }
  const highest = Math.max(0, ...out.map((d) => Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0)));
  const next = Number.isInteger(raw.nextId) && raw.nextId > highest ? raw.nextId : highest + 1;
  return { deliverables: out, next };
}

/** brief.md without its `# <id> <title>` line and the blank lines after it. */
function briefWithoutTitle(text, id) {
  const body = text.replace(/^﻿/, '');
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || !new RegExp(`^#\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lines[first])) return undefined;
  let rest = lines.slice(first + 1);
  while (rest.length > 0 && rest[0].trim() === '') rest = rest.slice(1);
  return rest.join('\n');
}

function migrateTask(vault, id, registry, created) {
  const dir = join(vault, 'tasks', id);
  let doc;
  try {
    doc = readJson(join(dir, 'task.json'));
  } catch {
    look(`${id}: task.json is not JSON - left as it is, and yan will list it as unreadable`);
    return;
  }
  if (doc.version === 2) return;

  const units = Array.isArray(doc.units) ? doc.units : [];
  const repos = [...new Set(units.map((u) => u?.repo).filter((r) => typeof r === 'string' && r !== ''))];
  if (repos.length > 1) look(`${id}: ${repos.length} repositories (${repos.join(', ')}) - kept the first, ${repos[0]}`);

  let deliverables = [];
  let next = 1;
  const record = join(dir, 'deliverable.json');
  if (existsSync(record)) {
    let parsed;
    try {
      parsed = deliverablesOf(readJson(record));
    } catch {
      parsed = { problem: 'not JSON' };
    }
    if (parsed.problem === undefined) {
      deliverables = parsed.deliverables;
      next = parsed.next;
      remove(record);
    } else {
      look(`${id}: deliverable.json could not be read (${parsed.problem}) - kept as deliverable.json.unmigrated, and the task has no deliverables`);
      if (!dryRun) renameSync(record, `${record}.unmigrated`);
    }
  }

  const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
  const createdAt = str(doc.createdAt) ?? created.get(id);
  const v2 = {
    version: 2,
    id: str(doc.id) ?? id,
    title: str(doc.title) ?? '',
    state: doc.abandoned === true ? 'abandoned' : doc.complete === true ? 'done' : 'open',
    ...(createdAt === undefined ? {} : { createdAt: new Date(createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z') }),
    ...(str(doc.closedAt) === undefined ? {} : { closedAt: doc.closedAt }),
    ...(repos.length === 0 ? {} : { repo: repoUrl(vault, repos[0], registry) }),
    nextDeliverable: next,
    deliverables,
  };
  writeJson(join(dir, 'task.json'), v2);

  const brief = join(dir, 'brief.md');
  if (existsSync(brief)) {
    const stripped = briefWithoutTitle(readFileSync(brief, 'utf8'), id);
    if (stripped !== undefined && !dryRun) writeFileSync(brief, stripped);
  } else if (!dryRun) {
    writeFileSync(brief, '');
  }

  const oldDrafts = join(dir, 'artifacts', 'drafts');
  if (isDir(oldDrafts)) {
    moveDir(oldDrafts, join(dir, 'drafts'));
    if (!dryRun && listDir(join(dir, 'artifacts')).length === 0) rmSync(join(dir, 'artifacts'), { recursive: true, force: true });
  }

  remove(join(dir, 'run'));
  remove(join(dir, '.enter.lock'));
  for (const sid of listDir(join(dir, 'shifts'))) remove(join(dir, 'shifts', sid, 'run'));
  for (const aborted of listDir(join(dir, 'artifacts', 'aborted-dispatches'))) remove(join(dir, 'artifacts', 'aborted-dispatches', aborted, 'run'));
}

/** `{ cli, model, effort }` from v3's `agents.yan`, a string or an object. */
function harnessConfig(old) {
  const yan = old?.agents?.yan;
  if (typeof yan === 'string') return { cli: yan.trim() || 'claude', model: '', effort: '' };
  const pick = (k) => (typeof yan?.[k] === 'string' ? yan[k].trim() : '');
  return { cli: pick('cli') || 'claude', model: pick('model'), effort: pick('effort') };
}

const GITIGNORE = `.DS_Store
# A browser profile an earlier yan's shift could leave behind: machine-local.
.chrome-profile/
`;

function migrateVault(vault) {
  said(`\nvault ${vault}`);
  let identity;
  try {
    identity = readJson(join(vault, 'vault.json'));
  } catch {
    look(`${vault}: no readable vault.json - not a vault, skipped`);
    return;
  }
  const version = typeof identity.version === 'number' ? identity.version : 1;
  if (version >= 2) {
    said(`  already version ${version} - nothing to do`);
    return;
  }

  // Tracked changes would be mixed into the migration's diff and could not be
  // told apart from it. Untracked files are migrated like the rest.
  const dirty = git(vault, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
  if (dirty !== '' && !dryRun) {
    look(`${vault}: has uncommitted changes - commit or push them first ('yan vault push' with the old yan), then run this again`);
    return;
  }
  const untracked = git(vault, ['status', '--porcelain', '--untracked-files=normal']).stdout.split('\n').filter((l) => l.startsWith('?? '));
  if (untracked.length > 0) look(`${vault}: migrated files git does not track yet (${untracked.map((l) => l.slice(3)).join(', ')}) - git cannot undo the migration there`);

  let registry = {};
  try {
    registry = readJson(join(vault, 'repos.json'));
  } catch {
    registry = {};
  }
  const created = firstCommitDays(vault);
  const ids = listDir(join(vault, 'tasks')).filter((id) => existsSync(join(vault, 'tasks', id, 'task.json')));

  const bar = progress('  tasks', ids.length);
  for (const id of ids) {
    migrateTask(vault, id, registry, created);
    bar.tick(id);
  }
  bar.done();

  // Learnings up a level; the rest of mem/ is gone.
  if (isDir(join(vault, 'mem', 'learnings'))) moveDir(join(vault, 'mem', 'learnings'), join(vault, 'learnings'));
  else if (!dryRun) mkdirSync(join(vault, 'learnings'), { recursive: true });
  const userMd = join(vault, 'mem', 'user.md');
  if (existsSync(userMd) && readFileSync(userMd, 'utf8').trim() !== '') {
    look(`${vault}: mem/user.md had content - moved to learnings/about-the-user.md`);
    if (!dryRun) renameSync(userMd, join(vault, 'learnings', 'about-the-user.md'));
  }
  const leftInMem = listDir(join(vault, 'mem')).filter((n) => !['user.md', 'learnings', '.gitkeep'].includes(n));
  if (leftInMem.length > 0) look(`${vault}: mem/ also held ${leftInMem.join(', ')} - removed with it (still in git history)`);
  remove(join(vault, 'mem'));

  let oldConfig = {};
  try {
    oldConfig = readJson(join(vault, 'config.json'));
  } catch {
    oldConfig = {};
  }
  writeJson(join(vault, 'config.json'), harnessConfig(oldConfig));

  const skills = listDir(join(vault, 'skills')).filter((n) => n !== '.gitkeep');
  if (skills.length > 0) look(`${vault}: removed skills/ (${skills.join(', ')}) - still in git history`);
  remove(join(vault, 'skills'));
  const hooks = listDir(join(vault, 'hooks')).filter((n) => n !== '.gitkeep');
  if (hooks.length > 0) look(`${vault}: hooks/ is not empty (${hooks.join(', ')}) - left as it is`);
  else remove(join(vault, 'hooks'));
  remove(join(vault, 'repos.json'));
  remove(join(vault, '.local'));
  if (!dryRun) writeFileSync(join(vault, '.gitignore'), GITIGNORE);

  writeJson(join(vault, 'vault.json'), { ...identity, version: 2 });
  said(dryRun ? '  would be migrated' : `  migrated - review with 'git -C ${vault} status', then 'yan vault push'`);
}

// ------------------------------------------------------------------- trees --

/** The main clone a worktree belongs to, from the `gitdir:` line of its `.git` file. */
function cloneOf(tree) {
  try {
    const line = readFileSync(join(tree, '.git'), 'utf8').trim();
    const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(line);
    return m === null ? undefined : m[1];
  } catch {
    return undefined;
  }
}

/** Every `<pool>/<slot>/<name>` tree under a pool directory. */
function treesIn(pool) {
  const found = [];
  for (const slot of listDir(pool).filter((n) => /^\d+$/.test(n))) {
    for (const name of listDir(join(pool, slot))) {
      if (existsSync(join(pool, slot, name, '.git'))) found.push(join(pool, slot, name));
    }
  }
  return found;
}

/** Move one pool directory: a rename, or a copy when the two roots are on different disks. */
function movePool(from, to) {
  try {
    renameSync(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
  }
  const slots = listDir(from);
  const bar = progress(`    copying ${basename(from)}`, slots.length);
  mkdirSync(to, { recursive: true });
  for (const slot of slots) {
    cpSync(join(from, slot), join(to, slot), { recursive: true, verbatimSymlinks: true });
    rmSync(join(from, slot), { recursive: true, force: true });
    bar.tick(slot);
  }
  rmSync(from, { recursive: true, force: true });
  bar.done();
}

/**
 * A lease as v4 has it: held by a task. A standing tree (`<task>/<unit>`)
 * becomes its task's. A shift's tree (`<task>/<unit>/<sid>`) has no owner any
 * more, so it is returned when that loses nothing, and listed when it would.
 */
function migrateLease(file, pool, held) {
  let lease;
  try {
    lease = readJson(file);
  } catch {
    look(`${file}: not JSON - left as it is`);
    return;
  }
  const parts = String(lease.holder ?? '').split('/');
  const tree = join(pool, String(lease.slot), basename(String(lease.path ?? '')));
  if (parts.length === 1) {
    writeJson(file, { ...lease, path: tree.replace(/\\/g, '/') });
    held.add(parts[0]);
    return;
  }
  if (parts.length === 2 && !held.has(parts[0])) {
    held.add(parts[0]);
    writeJson(file, { ...lease, path: tree.replace(/\\/g, '/'), holder: parts[0] });
    return;
  }
  const clean = existsSync(tree)
    && git(tree, ['status', '--porcelain']).stdout.trim() === ''
    && git(tree, ['branch', '-r', '--contains', 'HEAD']).stdout.trim() !== '';
  if (!existsSync(tree) || clean) {
    if (dryRun) said(`  would return ${tree}, held by ${lease.holder}`);
    if (!dryRun && existsSync(tree)) {
      git(tree, ['reset', '--hard', 'HEAD']);
      git(tree, ['clean', '-fd']);
    }
    remove(file);
    return;
  }
  look(`${tree}: held by ${lease.holder}, with work no remote has - push or discard it, then delete ${file}`);
  writeJson(file, { ...lease, path: tree.replace(/\\/g, '/') });
}

function migrateTrees() {
  said(`\npool ${oldPoolRoot} → ${newPoolRoot}`);
  if (!isDir(oldPoolRoot)) {
    said('  nothing at the old pool root - nothing to move');
  } else {
    const pools = listDir(oldPoolRoot).filter((n) => isDir(join(oldPoolRoot, n)));
    if (!dryRun) mkdirSync(newPoolRoot, { recursive: true });
    const bar = progress('  moving pools', pools.length);
    for (const name of pools) {
      const to = join(newPoolRoot, name);
      if (existsSync(to)) look(`${to} already exists - ${join(oldPoolRoot, name)} was left where it is`);
      else if (!dryRun) movePool(join(oldPoolRoot, name), to);
      bar.tick(name);
    }
    bar.done();
    if (!dryRun && listDir(oldPoolRoot).length === 0) rmSync(oldPoolRoot, { recursive: true, force: true });
  }
  // A dry run looks at the pools where they still are.
  const root = dryRun && isDir(oldPoolRoot) ? oldPoolRoot : newPoolRoot;
  if (!isDir(root)) return;

  // git keeps both ends of every link by absolute path: the tree's `.git`
  // names the clone, and the clone's .git/worktrees/ names the tree.
  const byClone = new Map();
  const pools = listDir(root).filter((n) => isDir(join(root, n)));
  for (const name of pools) {
    for (const tree of treesIn(join(root, name))) {
      const clone = cloneOf(tree);
      if (clone === undefined || !isDir(clone)) {
        look(`${tree}: its clone ${clone ?? '(unknown)'} is gone - the tree cannot be repaired; delete it when you are sure`);
        continue;
      }
      byClone.set(clone, [...(byClone.get(clone) ?? []), tree]);
    }
  }
  const repair = progress('  repairing git links', byClone.size);
  for (const [clone, trees] of byClone) {
    const r = dryRun ? { code: 0, stderr: '' } : git(clone, ['worktree', 'repair', ...trees]);
    if (r.code !== 0) look(`${clone}: git worktree repair failed - ${r.stderr.trim()}`);
    repair.tick(basename(clone));
  }
  repair.done();

  const held = new Set();
  for (const name of pools) {
    const leases = join(root, name, 'leases');
    for (const file of listDir(leases).filter((n) => n.endsWith('.json'))) migrateLease(join(leases, file), join(root, name), held);
  }
}

// ----------------------------------------------------------------- machine --

function migrateMachine() {
  const file = join(machineDir, 'config.json');
  let config;
  try {
    config = readJson(file);
  } catch {
    return;
  }
  if (!('clone_root' in config)) return;
  delete config.clone_root;
  writeJson(file, config);
  said(`\nmachine ${file}: clone_root dropped`);
}

// -------------------------------------------------------------------- main --

if (dryRun) said('dry run: nothing will be written');
const vaults = vaultsToMigrate();
if (vaults.length === 0) said(`no vaults registered in ${join(machineDir, 'config.json')}`);
for (const vault of vaults) migrateVault(vault);
if (!skipTrees) migrateTrees();
if (!dryRun) migrateMachine();

if (attention.length > 0) {
  said(`\n${attention.length} thing(s) to look at:`);
  for (const line of attention) said(`  - ${line}`);
  process.exitCode = 1;
} else {
  said('\ndone');
}
