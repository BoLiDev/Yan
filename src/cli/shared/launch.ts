import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { workspacePackages } from './packages.js';
import { repoName } from './repo-name.js';
import { openTasks } from './task-id.js';
import { repoKey } from '../../util/repo-key.js';
import { CREATE_NEW, type RepoChoice, type TaskChoice } from '../../ui/prompts.js';
import type { Said, Working } from '../../ui/chain.js';

export { CREATE_NEW };
export type { Said, Working };
import { tildePath } from './style.js';
import { cliKind, HARNESS_KINDS, isKnownCli, launchArgs } from '../../externals/harness/index.js';
import { WorktreePool, leasesHeldBy } from '../../externals/worktree/index.js';
import { cloneFor, register, registry, repoWithUrl } from '../../records/repos/index.js';
import { Task, type TaskRepo } from '../../records/task/index.js';
import { YanError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';
import { branchOf, defaultBranch, fetchAsync, git, gitOk, remoteUrl } from '../../util/git.js';
import { asString } from '../../util/narrow.js';
import { isDirectory, normalizePath, samePath } from '../../util/paths.js';
import { readVaultConfig, readVaultJson, vaultConfigPath, vaultDir } from '../../util/vault.js';

/**
 * Bare `yan`: pick a task or start one, then start the agent on it in this
 * terminal: in the task's first tree when it has trees, with the others
 * added beside it.
 *
 * The agent is told as little as will let it find the rest: the three parts
 * we think about a task in and which note keeps each, the two commands that read
 * them, where the task's files are, and which trees are which and what in
 * them the task is about. The
 * agent reads its notes with `yan context`, not `yan peek`, which is
 * `user`'s glance at a task and leaves the deliverables out. Which task it
 * is travels in `$YAN_TASK`, which every command reads, so the agent never
 * needs the id.
 */

/** What the agent is told before `user` says anything. */
export const OPENING_PROMPT = [
  'Notes from earlier sessions on this work are kept by a CLI.',
  'We think about a task in three parts, each with its note: the problem (problem.md: the background, and what the problem is), ' +
    'the solution (the deliverables: how things must be once it is solved), and the decisions that steered it (the log). ' +
    'Problem and solution are worked out with the user, not assumed, and either may change as the work goes. ' +
    'When one does, rewrite its note to say how things stand now, as if writing it for the first time: what it used to say belongs in the log.',
  'Resources the work refers to (Jira tickets, docs, MR links and the like) are kept under a name with `yan resource`, for later sessions to find.',
  '`yan context` shows the problem, the deliverables and the resources; `yan log` the decisions. `yan --help` for the rest.',
].join('\n');

/** One of the task's trees on this machine, as the agent is told about it. */
export interface Tree {
  /** The repository's registered name, or the last part of its URL. */
  readonly name: string;
  readonly path: string;
  readonly scope: readonly string[];
  /** The branch it is on as the agent starts, absent on a detached HEAD. */
  readonly branch?: string;
}

const quoted = (paths: readonly string[]): string => paths.map((p) => `\`${p}\``).join(', ');

/**
 * Said whenever the task has a tree. yan names no branch, since each machine
 * names its branches its own way, so the agent has to know to cut one; and
 * cutting one is the moment to keep it, which the agent does as it keeps a
 * resource, so the next start, on any machine, puts the tree back on it.
 */
const NO_BRANCH = 'yan never makes a branch: a worktree on a detached HEAD has to be put on a branch, ' +
  'named the way this repository and this machine expect, before committing in it. ' +
  'Once it is, `yan branch` in it keeps that branch for the task, and later sessions start the worktree on it.';

/**
 * Where this task's own files are, absolute, since the agent starts in a
 * worktree and never in the vault: problem.md, and artifacts/ for what the
 * work produces, which no command writes and so nothing else would name.
 */
function taskDirLine(dir: string): string {
  return `This task's files are in ${dir}: problem.md, and artifacts/ for whatever the work produces worth keeping.`;
}

/**
 * The opening prompt: the lines every agent gets, then where the task's
 * files are. A task with a tree adds the line on branches; one tree on a
 * branch or with a scope adds a line naming each; several add a line per
 * tree, since only the first is where the agent starts.
 */
export function openingPrompt(taskDir: string, trees: readonly Tree[] = []): string {
  const head = [OPENING_PROMPT, taskDirLine(taskDir)];
  if (trees.length === 0) return head.join('\n');
  if (trees.length > 1) {
    const lines = trees.map((t) => `- ${t.name}: ${t.path}${t.branch === undefined ? '' : `, on \`${t.branch}\``}${t.scope.length === 0 ? '' : `, about ${quoted(t.scope)}`}`);
    return [...head, `This task works in ${trees.length} repositories, one worktree each:`, ...lines, NO_BRANCH].join('\n');
  }
  const { scope = [], branch } = trees[0] ?? {};
  const on = branch === undefined ? [] : [`The worktree is on the branch \`${branch}\`.`];
  const about = scope.length === 0 ? [] : [`This task is about these parts of the repository: ${quoted(scope)}.`];
  return [...head, ...on, ...about, NO_BRANCH].join('\n');
}

/**
 * The harness `config.json` names, or claude with its own defaults.
 * Approvals are skipped unless `skipPermissions` is `false`.
 */
interface HarnessConfig {
  readonly cli: string;
  readonly model: string;
  readonly effort: string;
  readonly skipPermissions: boolean;
}

function harnessConfig(override: string | undefined): HarnessConfig {
  const raw = readVaultConfig() ?? {};
  const configured = {
    cli: asString(raw.cli).trim() || 'claude',
    model: asString(raw.model).trim(),
    effort: asString(raw.effort).trim(),
    skipPermissions: raw.skipPermissions !== false,
  };
  // A model chosen for the configured CLI means nothing to another one.
  const chosen = override === undefined || override === '' || override === configured.cli
    ? configured
    : { cli: override, model: '', effort: '', skipPermissions: configured.skipPermissions };
  if (!isKnownCli(chosen.cli)) {
    throw YanError.usage('yan_usage', `'${chosen.cli}' is not a CLI yan can start - one of: ${HARNESS_KINDS.join(' ')} (set "cli" in ${vaultConfigPath()})`);
  }
  return chosen;
}

/**
 * The main clone of the repository `dir` is in — the clone itself when `dir`
 * is a worktree of it — or `undefined` outside a repository.
 */
function mainClone(dir: string): string | undefined {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) return undefined;
  return normalizePath(dirname(common.stdout.trim()));
}

/** A tree as the line under its step says it: where it is, and what in it the task is about. */
function treeDetail(path: string, scope: readonly string[]): string {
  return `${tildePath(path)}${scope.length === 0 ? '' : ` · about ${scope.join(', ')}`}`;
}

/** The branch a tree is on, as a step's line says it; the agent may have cut one since the tree was leased. */
function headOf(tree: string): string {
  try {
    return branchOf(tree) ?? 'a detached HEAD';
  } catch {
    return 'a HEAD git cannot read';
  }
}

/** The branch a tree is on, or `undefined` on a detached HEAD or one git cannot read. */
function branchHere(tree: string): string | undefined {
  try {
    return branchOf(tree);
  } catch {
    return undefined;
  }
}

/** The first thing git said that explains a failure, for the dimmed line under a step. */
function firstLine(stderr: string): string {
  return stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? 'git said nothing';
}

/**
 * Lease `task` a tree of `clone`, as one step on the chain: a spinner while
 * origin is fetched, then a line saying where the tree stands. The tree is
 * on the branch the task keeps for this repository, or else on a detached
 * HEAD at origin's default branch, never on a branch of yan's making: each
 * machine names its branches its own way, so the agent cuts one before it
 * commits. A fetch that fails, or a kept branch the tree cannot be put on,
 * is a warning, not a stop.
 */
async function leaseTree(task: Task, repo: { name: string; clone: string; scope: readonly string[]; branch?: string }, chain: EntryChain): Promise<string> {
  const { name, clone, branch } = repo;
  const step = chain.working(`${name}: opening a worktree · fetching origin`);
  try {
    const fetched = await fetchAsync(clone);
    step.update(`${name}: opening a worktree`);

    const trunk = defaultBranch(clone);
    if (trunk === undefined) throw new YanError('yan_no_base', `cannot tell ${clone}'s default branch - set it with 'git -C ${clone} remote set-head origin --auto'`);
    const base = gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}^{commit}`]) ? `origin/${trunk}` : trunk;

    const pool = new WorktreePool(clone);
    let missed: string | undefined;
    let path: string | undefined;
    if (branch !== undefined) {
      try {
        path = pool.get(base, task.id, { branch }).path;
      } catch (err) {
        if (!(err instanceof YanError) || err.code !== 'worktree_branch') throw err;
        missed = err.message;
      }
    }
    path ??= pool.get(base, task.id).path;

    const detail = [treeDetail(path, repo.scope)];
    const warnings: string[] = [];
    let line = missed === undefined && branch !== undefined
      ? `${name}: worktree on ${branch}, the task's branch`
      : `${name}: worktree on a detached HEAD at ${base}`;
    if (missed !== undefined) {
      line = `${line} · not on the task's branch ${branch}`;
      warnings.push(missed);
    }
    if (fetched.code !== 0) {
      line = `${line} · could not fetch origin, so it may be behind`;
      warnings.push(firstLine(fetched.stderr));
    }
    step.finish({ kind: warnings.length === 0 ? 'done' : 'warn', line, detail: [...detail, ...warnings] });
    return path;
  } catch (err) {
    step.finish({ kind: 'warn', line: `${name}: no worktree` });
    throw err;
  }
}

/** The questions bare `yan` asks. The real ones are Clack's; a test answers them itself. */
export interface EntryPrompts {
  chooseEntry(tasks: readonly TaskChoice[], vault: string): Promise<string>;
  askTitle(): Promise<string>;
  chooseRepos(repos: readonly RepoChoice[]): Promise<string[]>;
  confirmTree(repo: string, why?: string): Promise<boolean>;
  chooseScope(repo: string, packages: readonly string[]): Promise<string[]>;
}

/**
 * What bare `yan` says between the questions and the agent, on the
 * questions' chain. The real one is Clack's; a test keeps what it was told.
 */
export interface EntryChain {
  working(doing: string): Working;
  say(said: Said): void;
  end(line: string): void;
}

/** Starting the agent; returns its exit status. */
type StartAgent = (cli: string, argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => number;

export interface EntryDeps {
  readonly prompts?: EntryPrompts;
  readonly chain?: EntryChain;
  readonly start?: StartAgent;
  /** Where `yan` was typed; the process's own directory by default. */
  readonly cwd?: string;
}

const startAgent: StartAgent = (cli, argv, options) => {
  const run = spawnSync(cli, [...argv], { stdio: 'inherit', cwd: options.cwd, env: options.env, windowsHide: true });
  if (run.error !== undefined) throw new YanError('yan_launch', `could not start ${cli}: ${run.error.message}`);
  return run.status ?? 1;
};

/** A repository a new task can be given: registered and cloned here, or the clone `yan` was typed in. */
interface Candidate {
  readonly name: string;
  readonly url: string;
  readonly clone: string;
  readonly registered: boolean;
}

/**
 * Every registered repository cloned on this machine, and the clone `yan` was
 * typed in when nothing registered it yet; picking that one registers it.
 */
function candidates(cwd: string): Candidate[] {
  const found: Candidate[] = registry()
    .filter((r) => r.clone !== undefined && isDirectory(r.clone))
    .map((r) => ({ name: r.name, url: r.url, clone: r.clone as string, registered: true }));
  const here = mainClone(cwd);
  const url = here === undefined ? undefined : remoteUrl(here);
  if (here !== undefined && url !== undefined && repoWithUrl(url) === undefined) {
    found.push({ name: repoKey(url).split('/').pop() ?? 'repo', url, clone: here, registered: false });
  }
  return found;
}

/**
 * Start a task: its title, the repositories it works in, picked from the
 * registry wherever `yan` was typed, and for each one that has several
 * packages, the ones it is about. Asked once; every later start reads them
 * from task.json. Each repository gets a tree.
 */
async function newTask(cwd: string, prompts: EntryPrompts, chain: EntryChain): Promise<{ task: Task; trees: Tree[] }> {
  const title = await prompts.askTitle();
  const offered = candidates(cwd);
  if (offered.length === 0) {
    chain.say({ kind: 'info', line: "no repository is registered and cloned here, so the task has no tree - 'yan repo add' registers one" });
    return { task: Task.create(title), trees: [] };
  }

  // The clone `yan` was typed in comes first, so it is where the agent starts when picked.
  const here = mainClone(cwd);
  const isHere = (c: Candidate): boolean => here !== undefined && samePath(here, c.clone);
  offered.sort((a, b) => Number(isHere(b)) - Number(isHere(a)));
  const names = await prompts.chooseRepos(offered.map((c) => ({
    name: c.name,
    hint: c.registered ? tildePath(c.clone) : `${tildePath(c.clone)} - not registered yet, picking it registers it`,
    here: isHere(c),
  })));
  const picked = offered.filter((c) => names.includes(c.name));

  const repos: Array<TaskRepo & { candidate: Candidate }> = [];
  for (const c of picked) {
    if (!c.registered) register(c.name, c.url, c.clone);
    const packages = workspacePackages(c.clone);
    const scope = packages.length === 0 ? [] : await prompts.chooseScope(c.name, packages);
    repos.push({ url: c.url, scope, candidate: c });
  }
  const task = Task.create(title, repos.map(({ url, scope }) => ({ url, ...(scope === undefined ? {} : { scope }) })));
  const trees: Tree[] = [];
  for (const r of repos) {
    const scope = r.scope ?? [];
    trees.push({ name: r.candidate.name, path: await leaseTree(task, { name: r.candidate.name, clone: r.candidate.clone, scope }, chain), scope });
  }
  return { task, trees };
}

/**
 * An existing task's trees on this machine, in the order task.json lists its
 * repositories. A repository with no tree here gets one, when `user` agrees,
 * from its linked clone or from the clone `yan` was typed in; one with no
 * clone here is named and skipped.
 */
async function existingTrees(task: Task, cwd: string, prompts: EntryPrompts, chain: EntryChain): Promise<Tree[]> {
  const held = leasesHeldBy(task.id).map((l) => ({ path: l.path, key: repoKey(remoteUrl(l.path) ?? '') }));
  const here = mainClone(cwd);
  const hereUrl = here === undefined ? undefined : remoteUrl(here);

  const slots: Array<{ repo: TaskRepo; path?: string; clone?: string }> = task.read().repos.map((repo) => {
    const tree = held.find((h) => h.key === repoKey(repo.url));
    if (tree !== undefined) {
      chain.say({ kind: 'done', line: `${repoName(repo.url)}: worktree on ${headOf(tree.path)}, already here`, detail: [treeDetail(tree.path, repo.scope ?? [])] });
      return { repo, path: tree.path };
    }
    const clone = cloneFor(repo.url) ?? (hereUrl !== undefined && repoKey(hereUrl) === repoKey(repo.url) ? here : undefined);
    return clone === undefined ? { repo } : { repo, clone };
  });

  for (const s of slots) {
    if (s.path === undefined && s.clone === undefined) {
      chain.say({ kind: 'warn', line: `${repoName(s.repo.url)} has no clone on this machine, so no tree - 'yan repo add' where it is cloned` });
    }
  }
  const openable = slots.filter((s) => s.path === undefined && s.clone !== undefined);
  if (openable.length > 0) {
    const names = openable.map((s) => repoName(s.repo.url)).join(', ');
    if (await prompts.confirmTree(names, `${task.id} has no tree of ${names} on this machine.`)) {
      for (const s of openable) {
        s.path = await leaseTree(task, { name: repoName(s.repo.url), clone: s.clone as string, scope: s.repo.scope ?? [], ...(s.repo.branch === undefined ? {} : { branch: s.repo.branch }) }, chain);
      }
    }
  }

  const trees: Tree[] = slots
    .filter((s) => s.path !== undefined)
    .map((s) => ({ name: repoName(s.repo.url), path: s.path as string, scope: s.repo.scope ?? [] }));
  // A tree of a repository task.json no longer lists is still the task's.
  for (const h of held) {
    if (!trees.some((t) => t.path === h.path)) trees.push({ name: h.key.split('/').pop() ?? h.key, path: h.path, scope: [] });
  }
  return trees;
}

/**
 * This yan, as a hook's shell command: the node running now and the bin/yan.mjs
 * beside dist/, so the hook does not depend on what PATH finds in the
 * agent's shell. Double-quoted, which sh and cmd both read.
 */
function yanCommand(args: readonly string[]): string {
  return [process.execPath, join(yanHome(), 'bin', 'yan.mjs'), ...args].map((w) => JSON.stringify(w)).join(' ');
}

/**
 * The vault kept in step around the agent without its knowing: pulled each
 * time `user` sends a message, pushed each time the agent finishes a turn.
 */
const VAULT_HOOKS = { prompt: ['vault', 'pull', '--hook'], stop: ['vault', 'push', '--hook'] } as const;

/**
 * The whole of bare `yan`, at a terminal. Returns the agent's exit status.
 *
 * @param extra arguments after `--`, passed to the harness as they are.
 */
export async function enter(options: { cli?: string; extra: readonly string[] }, deps: EntryDeps = {}): Promise<number> {
  const vault = vaultDir();
  const harness = harnessConfig(options.cli);
  const cwd = normalizePath(deps.cwd ?? process.cwd());
  const prompts = deps.prompts ?? (await import('../../ui/prompts.js'));
  const chain = deps.chain ?? (await import('../../ui/chain.js'));

  const chosen = await prompts.chooseEntry(openTasks(), readVaultJson(vault).name);
  const { task, trees } = chosen === CREATE_NEW
    ? await newTask(cwd, prompts, chain)
    : { task: new Task(chosen), trees: await existingTrees(new Task(chosen), cwd, prompts, chain) };

  chain.end(`${task.id}  ${task.read().title} · ${cliKind(harness.cli)} starting`);

  const told = trees.map((t) => {
    const branch = branchHere(t.path);
    return branch === undefined ? t : { ...t, branch };
  });
  const workdir = trees[0]?.path ?? cwd;
  const addDirs = trees.slice(1).map((t) => t.path);
  const argv = [...launchArgs(harness.cli, { ...harness, workdir, addDirs, prompt: openingPrompt(task.dir, told), hooks: { prompt: yanCommand(VAULT_HOOKS.prompt), stop: yanCommand(VAULT_HOOKS.stop) } }), ...options.extra];
  // The vault is explicit, so `yan vault use` elsewhere cannot move a running agent.
  return (deps.start ?? startAgent)(harness.cli, argv, { cwd: workdir, env: { ...process.env, YAN_TASK: task.id, YAN_VAULT: vault } });
}
