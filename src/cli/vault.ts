import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { currentBranch, git, remoteUrl, statusPorcelain } from '../util/git.js';
import { YanError } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { writeJson } from '../util/json.js';
import { machineConfigPath, readMachine, registerVault, registeredVaults, setActiveVault } from '../util/machine.js';
import { isDirectory, normalizePath } from '../util/paths.js';
import { localDay } from '../util/time.js';
import { VAULT_VERSION, isVault, readVaultJson, vaultDir } from '../util/vault.js';
import { action, out } from './shared/action.js';
import { pullVault } from './shared/vault-pull.js';
import { isTty } from './shared/tty.js';
import { isRecordId } from '../util/names.js';

/**
 * `yan vault …` — which context's tasks yan reads and writes.
 *
 * The only command that runs without a vault, and the only writer of
 * `~/.yan/config.json`. `init` needs a remote that already exists and is
 * empty; it never creates one.
 */

function checkName(name: string): void {
  if (!isRecordId(name)) {
    throw YanError.usage('vault_usage', `'${name}' is not a usable vault name - letters, digits, dot, dash and underscore`);
  }
}

/** A directory that does not exist, or exists and has nothing in it. */
function emptyEnough(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return isDirectory(dir) && readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Where a vault goes when nobody said: beside yan's own clone. */
function defaultVaultPath(name: string): string {
  return normalizePath(join(dirname(yanHome()), `yan-vault-${name}`));
}

function gitOrThrow(dir: string, args: readonly string[], what: string): void {
  const result = git(dir, args);
  if (result.code !== 0) {
    const detail = (result.stderr === '' ? result.stdout : result.stderr).trim();
    throw new YanError('vault_git_failed', `${what} failed: git ${args.join(' ')}\n${detail}`);
  }
}

/**
 * Copy `templates/vault/` into `dir`, then write its vault.json and README.
 *
 * @throws YanError `vault_template_missing` when the template is not there.
 */
function layDownSkeleton(dir: string, name: string): void {
  const template = join(yanHome(), 'templates', 'vault');
  if (!existsSync(template)) {
    throw new YanError('vault_template_missing', `${template} is missing - run 'npm run build' in ${yanHome()}`);
  }
  mkdirSync(dir, { recursive: true });
  cpSync(template, dir, { recursive: true });
  // The template ships as an example; the vault it seeds holds the real one.
  renameSync(join(dir, 'config.example.json'), join(dir, 'config.json'));

  writeJson(join(dir, 'vault.json'), { version: VAULT_VERSION, name, created: localDay() });

  writeFileSync(
    join(dir, 'README.md'),
    [
      `# ${name}`,
      '',
      "A yan vault: one context's tasks — their briefs, logs, deliverables,",
      'drafts and artifacts — and the learnings worth keeping beyond one task.',
      '',
      'The code lives somewhere else entirely. To use this vault on another',
      'machine:',
      '',
      '```',
      'yan vault clone <this repository>',
      '```',
      '',
    ].join('\n'),
  );
}

/**
 * The refusal for a value `argv` left out when there is no terminal to ask
 * on, so nothing unattended can hang on a prompt. Each entry is a flag as a
 * person types it and one line about it.
 */
function refuseMissing(missing: readonly (readonly [string, string])[]): never {
  const flags = missing.map(([flag, describe]) => `  ${flag} <value>   ${describe}`).join('\n');
  throw YanError.usage('missing_options', `missing required option${missing.length > 1 ? 's' : ''}; pass:\n${flags}`);
}

async function initAnswers(name: string, remote: string): Promise<{ name: string; remote: string }> {
  if (name !== '' && remote !== '') return { name, remote };
  if (!isTty()) {
    refuseMissing([
      ...(name === '' ? [['<name>', 'a short name for this context, e.g. personal'] as const] : []),
      ...(remote === '' ? [['--remote', 'the empty repository to push this vault to'] as const] : []),
    ]);
  }
  const { askVaultInit } = await import('../ui/prompts.js');
  return askVaultInit({ name, remote });
}

async function cloneUrl(url: string): Promise<string> {
  if (url !== '') return url;
  if (!isTty()) refuseMissing([['<url>', 'the vault repository to clone']]);
  const { askVaultClone } = await import('../ui/prompts.js');
  return askVaultClone();
}

interface InitOptions {
  readonly remote?: string;
  readonly path?: string;
}

const initVault = new Command('init')
  .description('create a vault, push it to an empty remote, and make it active')
  .argument('[name]')
  .option('--remote <url>', 'the empty repository this vault is pushed to')
  .option('--path <dir>', 'where the vault lives on this machine')
  .action(
    action('yan vault init', async (name: string | undefined, options: InitOptions) => {
      const answers = await initAnswers(name ?? '', options.remote ?? '');
      checkName(answers.name);

      if (readMachine().vaults[answers.name] !== undefined) {
        throw new YanError('vault_conflict', `'${answers.name}' is already registered - 'yan vault ls' shows where`);
      }

      const dir = normalizePath(resolve(options.path ?? defaultVaultPath(answers.name)));
      if (!emptyEnough(dir)) {
        throw new YanError('vault_conflict', `${dir} already exists and is not empty - pass --path, or move it aside`);
      }

      // Both refusals land before a single file is written.
      const heads = git(yanHome(), ['ls-remote', '--heads', answers.remote]);
      if (heads.code !== 0) {
        throw new YanError('vault_remote_unreachable', `cannot reach ${answers.remote} - create the repository first, then run this again\n${(heads.stderr || heads.stdout).trim()}`);
      }
      if (heads.stdout.trim() !== '') {
        throw new YanError('vault_remote_not_empty', `${answers.remote} already has branches, so it is not an empty repository - 'yan vault clone ${answers.remote}' takes an existing vault; init needs an empty one`);
      }

      layDownSkeleton(dir, answers.name);
      gitOrThrow(dir, ['init', '--initial-branch=main'], 'git init');
      gitOrThrow(dir, ['add', '-A'], 'staging the skeleton');
      gitOrThrow(dir, ['commit', '-m', `vault: ${answers.name}`], 'the first commit');
      gitOrThrow(dir, ['remote', 'add', 'origin', answers.remote], 'adding the remote');
      gitOrThrow(dir, ['push', '-u', 'origin', 'main'], 'the first push');

      registerVault(answers.name, dir);

      out(`vault init: ${answers.name}  ${dir}`);
      out(`vault init: pushed to ${answers.remote}, and it is now the active vault`);
    }),
  );

const cloneVault = new Command('clone')
  .description('take an existing vault on this machine and make it active')
  .argument('[url]')
  .option('--name <name>', "register under this name instead of the vault's own")
  .option('--path <dir>', 'where the vault lives on this machine')
  .action(
    action('yan vault clone', async (url: string | undefined, options: { name?: string; path?: string }) => {
      const answers = { url: await cloneUrl(url ?? '') };

      // Only for the directory name: the registered name comes from vault.json.
      const provisional = options.name ?? 'vault';
      const dir = normalizePath(resolve(options.path ?? defaultVaultPath(provisional)));
      if (!emptyEnough(dir)) {
        throw new YanError('vault_conflict', `${dir} already exists and is not empty - pass --path, or move it aside`);
      }

      mkdirSync(dirname(dir), { recursive: true });
      gitOrThrow(dirname(dir), ['clone', answers.url, dir], 'cloning the vault');

      if (!isVault(dir)) {
        throw new YanError('vault_invalid', `${answers.url} has no vault.json, so it is not a vault - 'yan vault init' creates one`);
      }
      const identity = readVaultJson(dir);
      const name = options.name !== undefined && options.name !== '' ? options.name : identity.name;
      checkName(name);
      if (readMachine().vaults[name] !== undefined) {
        throw new YanError('vault_conflict', `'${name}' is already registered on this machine - pass --name`);
      }

      registerVault(name, dir);
      out(`vault clone: ${name}  ${dir}  (active)`);
    }),
  );

const lsVaults = new Command('ls')
  .description('the vaults registered on this machine')
  .action(
    action('yan vault ls', () => {
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
    }),
  );

/**
 * Make a registered vault the active one, warning rather than failing when it
 * has no vault.json.
 *
 * @throws YanError `vault_usage` when no name is given, `vault_missing` when it is not
 *   registered here.
 */
export function useVault(name: string | undefined): void {
  if (name === undefined || name === '') {
    throw YanError.usage('vault_usage', "a vault name is required - 'yan vault ls' lists them");
  }
  const path = readMachine().vaults[name];
  if (path === undefined) {
    const known = registeredVaults().map((v) => v.name);
    throw new YanError('vault_missing', `no such vault: ${name}${known.length > 0 ? ` - registered: ${known.join(', ')}` : ''}`);
  }
  setActiveVault(name);
  out(`vault use: ${name}  ${path}`);
  if (!isVault(path)) {
    out(`vault use: WARNING ${path} has no vault.json - clone it again, or fix ${machineConfigPath()}`);
  }
}

const useCommand = new Command('use')
  .description('switch the active vault')
  .argument('[name]')
  .action(action('yan vault use', (name: string | undefined) => { useVault(name); }));

/** `yan vault pull` and `yan vault push`: by hand, when `user` says so. */
const pullCommand = new Command('pull')
  .description('fetch and rebase the vault onto its remote')
  .action(
    action('yan vault pull', () => {
      const result = pullVault();
      out(`vault pull: ${result.message}`);
      if (!result.ok) process.exitCode = 1;
    }),
  );

/** A commit message naming the task ids that changed, for when nobody supplied one. */
function pushMessage(changed: readonly string[]): string {
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
    action('yan vault push', (options: { message?: string }) => {
      const dir = vaultDir();
      if (remoteUrl(dir) === undefined) {
        throw new YanError('vault_no_remote', `${dir} has no origin - add one with: git -C ${dir} remote add origin <url>`);
      }

      // --untracked-files=all, or a new directory counts as one entry.
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
 * `yan vault where` — the active vault's path, or the same refusal every other
 * command would have given.
 */
const whereCommand = new Command('where')
  .description('the active vault directory')
  .action(action('yan vault where', () => { out(vaultDir()); }));

export const command = new Command('vault')
  .description("the vault: one context's tasks, kept in a git repository of its own")
  .addCommand(initVault)
  .addCommand(cloneVault)
  .addCommand(lsVaults)
  .addCommand(useCommand)
  .addCommand(pullCommand)
  .addCommand(pushCommand)
  .addCommand(whereCommand);
