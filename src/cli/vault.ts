import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { Command } from 'commander';
import { currentBranch, fetch, git, gitOk, rebase, remoteUrl, revParse, statusPorcelain } from '../util/git.js';
import { isYanError } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { writeJson } from '../util/json.js';
import {
  cloneRoot,
  machineConfigPath,
  readMachine,
  registerVault,
  registeredVaults,
  setActiveVault,
  setCloneRoot,
} from '../util/machine.js';
import { normalizePath } from '../util/paths.js';
import { VAULT_VERSION, isVault, readVaultJson, vaultDir } from '../util/vault.js';
import { WorktreePool } from '../externals/worktree/index.js';
import { action, out } from './shared/action.js';
import { dropHome, migrate, planMigration, preflight, stillOnlyInHome } from './shared/migrate.js';
import { CommandError } from './shared/errors.js';
import { resolve } from './shared/resolve.js';

/**
 * `yan vault …` — the context a session works in (v3 td vault.md).
 *
 * This is the only command that may run without a vault, and the only one that
 * writes `~/.yan/config.json`. Both follow from what it is: the thing you run
 * before yan has anywhere to put anything.
 *
 * The remote has to exist and be empty before `init`. Creating a repository on
 * a forge is a thirty-second click, and the alternative is a code path that has
 * to handle two APIs, two auth stories and a name collision — for one command
 * a person runs twice in their life.
 */

const NAME_RULE = /^[A-Za-z0-9._-]+$/;

function checkName(name: string): void {
  if (!NAME_RULE.test(name)) {
    throw CommandError.usage('vault', `'${name}' is not a usable vault name - letters, digits, dot, dash and underscore`);
  }
}

/** A directory that does not exist, or exists and has nothing in it. */
function emptyEnough(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Where a vault goes when nobody said: beside the mechanics clone.
 *
 * Beside rather than inside, because "inside `$YAN_HOME`" is precisely the
 * arrangement V3 exists to undo, and a default that recreates it would be a
 * quiet way to end up back where we started.
 */
function defaultVaultPath(name: string): string {
  return normalizePath(join(dirname(yanHome()), `yan-vault-${name}`));
}

function gitOrThrow(dir: string, args: readonly string[], what: string): void {
  const result = git(dir, args);
  if (result.code !== 0) {
    const detail = (result.stderr === '' ? result.stdout : result.stderr).trim();
    throw new CommandError('vault', 'git_failed', `${what} failed: git ${args.join(' ')}\n${detail}`);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The skeleton, from `templates/vault/` in the mechanics.
 *
 * All of it, including `config.json`. There used to be a second copy of that
 * one in `conf/config.sample.json` and a step here to fetch it; `conf/` held
 * nothing but templates once the real config moved into the vault, so it is
 * gone and the template is the sample.
 */
function layDownSkeleton(dir: string, name: string): void {
  const template = join(yanHome(), 'templates', 'vault');
  if (!existsSync(template)) {
    throw new CommandError('vault', 'template_missing', `${template} is missing - run 'npm run build' in ${yanHome()}`);
  }
  mkdirSync(dir, { recursive: true });
  cpSync(template, dir, { recursive: true });

  writeJson(join(dir, 'vault.json'), { version: VAULT_VERSION, name, created: today() });

  writeFileSync(
    join(dir, 'README.md'),
    [
      `# ${name}`,
      '',
      "A yan vault: one context's task assets — tasks, briefs, outcomes, logs,",
      'artifacts, memory, and the repository registry.',
      '',
      'The mechanics live somewhere else entirely. To use this vault on another',
      'machine:',
      '',
      '```',
      'yan vault clone <this repository>',
      '```',
      '',
      'then `yan repo add` in the directory holding your clones, to say where',
      'each registered repository is on that disk.',
      '',
    ].join('\n'),
  );
}

interface InitOptions {
  readonly remote?: string;
  readonly path?: string;
  readonly cloneRoot?: string;
  readonly fromHome?: boolean;
  readonly dropHome?: boolean;
}

/**
 * How many trees the pool is holding for a clone that is about to move.
 *
 * Asked through the pool rather than by reading its directory, and any failure
 * counts as zero: a pool that cannot be opened has no leases to lose.
 */
function leasesFor(clone: string): number {
  try {
    return new WorktreePool(clone).status().length;
  } catch {
    return 0;
  }
}

const initVault = new Command('init')
  .description('create a vault, push it to an empty remote, and make it active')
  .argument('[name]')
  .option('--remote <url>', 'the empty repository this vault is pushed to')
  .option('--path <dir>', 'where the vault lives on this machine')
  .option('--clone-root <dir>', 'where `yan repo add <url>` clones into on this machine')
  .option('--from-home', "move this $YAN_HOME's tasks, memory, config and clones into the new vault")
  .option('--drop-home', 'with --from-home: delete the old copies once the vault is written')
  .action(
    action('vault_init', async (name: string | undefined, options: InitOptions) => {
      const answers = await resolve(
        { name: name ?? '', remote: options.remote ?? '' },
        [
          { name: 'name', flag: '<name>', describe: 'a short name for this context, e.g. personal' },
          { name: 'remote', flag: '--remote', describe: 'the empty repository to push this vault to' },
        ],
      );
      checkName(answers.name);

      if (readMachine().vaults[answers.name] !== undefined) {
        throw new CommandError('vault', 'conflict', `'${answers.name}' is already registered - 'yan vault ls' shows where`);
      }

      const dir = normalizePath(resolvePath(options.path ?? defaultVaultPath(answers.name)));
      if (!emptyEnough(dir)) {
        throw new CommandError('vault', 'conflict', `${dir} already exists and is not empty - pass --path, or move it aside`);
      }

      // Both refusals happen before a single file is written. A remote that
      // already has commits is the likeliest mistake here — pointing init at
      // the wrong repository — and finding out from a rejected push, after the
      // skeleton is on disk and committed, leaves a half-made vault to clean up
      // by hand.
      const heads = git(yanHome(), ['ls-remote', '--heads', answers.remote]);
      if (heads.code !== 0) {
        throw new CommandError('vault', 'remote_unreachable', `cannot reach ${answers.remote} - create the repository first, then run this again\n${(heads.stderr || heads.stdout).trim()}`);
      }
      if (heads.stdout.trim() !== '') {
        throw new CommandError('vault', 'remote_not_empty', `${answers.remote} already has branches, so it is not an empty repository - 'yan vault clone ${answers.remote}' takes an existing vault; init needs an empty one`);
      }

      const root = normalizePath(resolvePath(options.cloneRoot ?? cloneRoot() ?? dirname(yanHome())));

      // Everything the migration could refuse for is refused here, before the
      // skeleton exists — so a refusal leaves nothing behind to clean up.
      const plan = options.fromHome === true ? planMigration(dir, root) : undefined;
      if (plan !== undefined) preflight(plan, leasesFor);

      layDownSkeleton(dir, answers.name);
      if (plan !== undefined) migrate(plan);
      gitOrThrow(dir, ['init', '--initial-branch=main'], 'git init');
      gitOrThrow(dir, ['add', '-A'], 'staging the skeleton');
      gitOrThrow(dir, ['commit', '-m', `vault: ${answers.name}`], 'the first commit');
      gitOrThrow(dir, ['remote', 'add', 'origin', answers.remote], 'adding the remote');
      gitOrThrow(dir, ['push', '-u', 'origin', 'main'], 'the first push');

      registerVault(answers.name, dir);
      setCloneRoot(root);

      out(`vault init: ${answers.name}  ${dir}`);
      out(`vault init: pushed to ${answers.remote}, and it is now the active vault`);
      out(`vault init: clones on this machine go under ${root}`);

      if (plan !== undefined) {
        // The old copy stays until someone has looked. `--drop-home` is the
        // second run, after `yan ls` and `yan doctor` agree; without it this
        // migration is undone by deleting one directory.
        if (options.dropHome === true) dropHome(plan);
        else out(`vault init: the old data is still in ${plan.home} - check 'yan ls' and 'yan doctor', then re-run with --drop-home, or delete tasks/ mem/ repos/ conf/config.json by hand`);
      }
    }),
  );

const cloneVault = new Command('clone')
  .description('take an existing vault on this machine and make it active')
  .argument('[url]')
  .option('--name <name>', "register under this name instead of the vault's own")
  .option('--path <dir>', 'where the vault lives on this machine')
  .action(
    action('vault_clone', async (url: string | undefined, options: { name?: string; path?: string }) => {
      const answers = await resolve({ url: url ?? '' }, [
        { name: 'url', flag: '<url>', describe: 'the vault repository to clone' },
      ]);

      // A provisional directory name only: the real one comes out of vault.json
      // below, because the vault names itself and a URL is only a guess at it.
      const provisional = options.name ?? 'vault';
      const dir = normalizePath(resolvePath(options.path ?? defaultVaultPath(provisional)));
      if (!emptyEnough(dir)) {
        throw new CommandError('vault', 'conflict', `${dir} already exists and is not empty - pass --path, or move it aside`);
      }

      mkdirSync(dirname(dir), { recursive: true });
      gitOrThrow(dirname(dir), ['clone', answers.url, dir], 'cloning the vault');

      if (!isVault(dir)) {
        throw new CommandError('vault', 'invalid', `${answers.url} has no vault.json, so it is not a vault - 'yan vault init' creates one`);
      }
      const identity = readVaultJson(dir);
      const name = options.name !== undefined && options.name !== '' ? options.name : identity.name;
      checkName(name);
      if (readMachine().vaults[name] !== undefined) {
        throw new CommandError('vault', 'conflict', `'${name}' is already registered on this machine - pass --name`);
      }

      registerVault(name, dir);
      if (cloneRoot() === undefined) setCloneRoot(dirname(yanHome()));

      out(`vault clone: ${name}  ${dir}  (active)`);
      out(`vault clone: run 'yan repo add' where your clones live - this machine has no paths for them yet`);
    }),
  );

const lsVaults = new Command('ls')
  .description('the vaults registered on this machine')
  .action(
    action('vault_ls', () => {
      const vaults = registeredVaults();
      if (vaults.length === 0) {
        out(`no vaults are registered in ${machineConfigPath()}`);
        out("create one with 'yan vault init <name> --remote <url>'");
        return;
      }
      const active = readMachine().active;
      for (const { name, path } of vaults) {
        const mark = name === active ? '*' : ' ';
        const state = isVault(path) ? '' : '   MISSING';
        out(`${mark} ${name.padEnd(16)}${path}${state}`);
      }
      out(`clone_root  ${cloneRoot() ?? '(unset)'}`);
    }),
  );

/** Shared by `yan vault use` and its top-level alias, so they cannot disagree. */
export function useVault(name: string | undefined): void {
  if (name === undefined || name === '') {
    throw CommandError.usage('vault', "a vault name is required - 'yan vault ls' lists them");
  }
  const path = readMachine().vaults[name];
  if (path === undefined) {
    const known = registeredVaults().map((v) => v.name);
    throw new CommandError('vault', 'missing', `no such vault: ${name}${known.length > 0 ? ` - registered: ${known.join(', ')}` : ''}`);
  }
  setActiveVault(name);
  out(`vault use: ${name}  ${path}`);
  if (!isVault(path)) {
    out(`vault use: WARNING ${path} has no vault.json - clone it again, or fix ${machineConfigPath()}`);
  }
}

/**
 * `yan vault link <name> <path>` — where a vault is on this machine.
 *
 * The exact dual of `yan repo link`, and it exists for the same reason: a
 * directory moves, and the only record of where it was is the machine layer,
 * which nothing but this command may write (design principle 2, one owner per
 * piece of information). Editing `~/.yan/config.json` by hand works right up
 * until it is the thing that is wrong.
 *
 * It checks the destination really is a vault first. A registration pointing
 * at a directory with no `vault.json` produces the same failure as no
 * registration at all, one command later and with a worse message.
 */
const linkCommand = new Command('link')
  .description('say where a registered vault is on this machine')
  .argument('[name]')
  .argument('[path]')
  .action(
    action('vault_link', (name: string | undefined, path: string | undefined) => {
      if (name === undefined || name === '' || path === undefined || path === '') {
        throw CommandError.usage('vault', "both a name and a path are required: 'yan vault link <name> <path>'");
      }
      const known = readMachine().vaults[name];
      if (known === undefined) {
        throw new CommandError('vault', 'missing', `no such vault: ${name} - 'yan vault ls' lists them; 'yan vault clone <url>' registers a new one`);
      }
      const dir = normalizePath(resolvePath(path));
      if (!isVault(dir)) {
        throw new CommandError('vault', 'invalid', `${dir} has no vault.json, so it is not a vault - move the directory first, then link it`);
      }
      const found = readVaultJson(dir).name;
      if (found !== '' && found !== name) {
        // Not fatal: the registered name is this machine's label and the
        // vault's own name is what it calls itself. Worth saying out loud,
        // because the usual cause is linking the wrong directory.
        out(`vault link: note - ${dir} calls itself '${found}', and it is registered here as '${name}'`);
      }
      registerVault(name, dir, readMachine().active === name);
      out(`vault link: ${name}  ${dir}`);
    }),
  );

const useCommand = new Command('use')
  .description('switch the active vault')
  .argument('[name]')
  .action(action('vault_use', (name: string | undefined) => { useVault(name); }));

/**
 * `yan vault pull` and `yan vault push` (v3 td vault.md §5).
 *
 * Two commands, deliberately not one, and neither of them called `sync`: the
 * word says which way the data moved, and here that is the whole question.
 * Pull and push have different authorities, so a single verb hiding both is a
 * collision in the only place it matters, which is a tired person's memory.
 *
 * Pull is automatic (session-start runs it) and push is not, because push
 * writes to a remote and that is `user`'s call — and because auto-committing
 * every `log.md` append would produce a history nobody can read.
 */
export interface PullResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Never throws. Session-start calls it, and a session that refuses to start
 * because a remote is unreachable is a worse tool than one that does not sync.
 */
export function pullVault(): PullResult {
  let dir: string;
  try {
    dir = vaultDir();
  } catch (err) {
    return { ok: false, message: isYanError(err) ? err.message : String(err) };
  }

  if (remoteUrl(dir) === undefined) {
    return { ok: false, message: 'this vault has no origin, so there is nothing to pull from' };
  }
  const dirty = statusPorcelain(dir).trim();
  if (dirty !== '') {
    // Refused rather than attempted: a half-finished rebase in a directory the
    // reader does not think of as a repository is a bad place to be left.
    return {
      ok: false,
      message: `the vault has uncommitted changes, so it was not rebased - 'yan vault push' first, or commit them by hand:\n${dirty.split(/\r?\n/).slice(0, 10).map((l) => `    ${l}`).join('\n')}`,
    };
  }

  const fetched = fetch(dir);
  if (fetched.code !== 0) {
    return { ok: false, message: `could not reach ${remoteUrl(dir) ?? 'origin'}: ${fetched.stderr.trim()}` };
  }
  const branch = currentBranch(dir);
  if (!gitOk(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    return { ok: false, message: `origin has no ${branch} yet - 'yan vault push' publishes it` };
  }

  const before = revParse(dir, ['HEAD']);
  const rebased = rebase(dir, [`origin/${branch}`]);
  if (rebased.code !== 0) {
    git(dir, ['rebase', '--abort']);
    return { ok: false, message: `rebasing onto origin/${branch} conflicts - open ${dir} and sort it out; nothing was changed` };
  }
  const after = revParse(dir, ['HEAD']);
  return {
    ok: true,
    message: before === after ? `already up to date with origin/${branch}` : `caught up with origin/${branch}`,
  };
}

const pullCommand = new Command('pull')
  .description('fetch and rebase the vault onto its remote')
  .action(
    action('vault_pull', () => {
      const result = pullVault();
      out(`vault pull: ${result.message}`);
      if (!result.ok) process.exitCode = 1;
    }),
  );

/**
 * A commit message from what changed, when nobody supplied one.
 *
 * Task ids rather than file names: "t103, t104" is what a person scanning the
 * vault's history is looking for, and the file names underneath are all
 * task.json and log.md.
 */
export function pushMessage(changed: readonly string[]): string {
  const tasks = [...new Set(changed.map((p) => /^tasks\/([^/]+)\//.exec(p)?.[1]).filter((id): id is string => id !== undefined))].sort();
  const others = changed.filter((p) => !p.startsWith('tasks/')).length;
  if (tasks.length === 0) return `vault: ${changed.length} file(s)`;
  const head = tasks.length > 4 ? `${tasks.slice(0, 4).join(', ')} and ${tasks.length - 4} more` : tasks.join(', ');
  return others > 0 ? `${head}, and ${others} other file(s)` : head;
}

const pushCommand = new Command('push')
  .description('commit everything in the vault and push it')
  .option('-m, --message <text>', 'the commit message, instead of one derived from what changed')
  .action(
    action('vault_push', (options: { message?: string }) => {
      const dir = vaultDir();
      if (remoteUrl(dir) === undefined) {
        throw new CommandError('vault', 'no_remote', `${dir} has no origin - add one with: git -C ${dir} remote add origin <url>`);
      }

      // --untracked-files=all: without it git reports a new directory as one
      // entry, so a brand-new task would be 'committed 1 change(s)' however
      // much is in it, and the derived message would be counting directories.
      const changed = statusPorcelain(dir, ['--untracked-files=all'])
        .split(/\r?\n/)
        .map((l) => l.slice(3).trim())
        .filter((p) => p !== '');

      if (changed.length > 0) {
        gitOrThrow(dir, ['add', '-A'], 'staging the vault');
        gitOrThrow(dir, ['commit', '-m', options.message ?? pushMessage(changed)], 'committing the vault');
        out(`vault push: committed ${changed.length} change(s)`);
      } else {
        out('vault push: nothing to commit');
      }

      const branch = currentBranch(dir);
      gitOrThrow(dir, ['push', '-u', 'origin', branch], 'pushing the vault');
      out(`vault push: ${branch} → ${remoteUrl(dir) ?? 'origin'}`);
    }),
  );

/**
 * `yan vault drop-home` — step 7 of the migration, as its own command.
 *
 * The migration is deliberately additive: `--from-home` copies, and the old
 * data stays until someone has looked at `yan ls` and `yan doctor`. Looking
 * takes as long as it takes, which is longer than one command — so the
 * deletion has to be runnable afterwards rather than only as a flag on the
 * run that created the vault.
 *
 * It re-checks before it removes anything, and the check is the whole reason
 * this is not `rm -rf`: every task and every registry entry the old home holds
 * must already be in the active vault.
 */
const dropHomeCommand = new Command('drop-home')
  .description('remove the pre-V3 data from $YAN_HOME, once the vault has it')
  .action(
    action('vault_drop_home', () => {
      const vault = vaultDir();
      const plan = planMigration(vault, cloneRoot() ?? dirname(yanHome()));

      const missing = stillOnlyInHome(plan);
      if (missing.length > 0) {
        throw new CommandError('vault', 'incomplete', `${plan.home} still holds things the vault does not:\n${missing.map((m) => `  - ${m}`).join('\n')}\nnothing was removed - run 'yan vault init <name> --remote <url> --from-home' first`);
      }
      if (plan.tasks.length === 0 && !plan.config && plan.repos.length === 0) {
        out(`vault drop-home: nothing left in ${plan.home} to remove`);
        return;
      }
      dropHome(plan);
    }),
  );

/**
 * `yan vault where` — one line, for a script or a person who lost track.
 *
 * It goes through `vaultDir()` rather than the forgiving variant on purpose:
 * this is the command you run when something is wrong, so it should produce
 * exactly the refusal every other command would have produced, with the same
 * words and the same exit code.
 */
const whereCommand = new Command('where')
  .description('the active vault directory')
  .action(action('vault_where', () => { out(vaultDir()); }));

export const command = new Command('vault')
  .description('the task assets this session works in')
  .addCommand(initVault)
  .addCommand(cloneVault)
  .addCommand(lsVaults)
  .addCommand(linkCommand)
  .addCommand(useCommand)
  .addCommand(dropHomeCommand)
  .addCommand(pullCommand)
  .addCommand(pushCommand)
  .addCommand(whereCommand);
