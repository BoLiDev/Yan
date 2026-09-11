import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Command } from 'commander';
import { gitOut, remoteUrl } from '../util/git.js';
import { yanHome } from '../util/home.js';
import { readJsonIfPresent } from '../util/json.js';
import { activeVaultName, cloneRoot, machineConfigPath } from '../util/machine.js';
import { VAULT_VERSION, readVaultJson, vaultDirIfAny } from '../util/vault.js';
import { HERDR_PROTOCOL, HERDR_SCHEMA_VERSION, herdrHealth } from '../externals/herdr/index.js';
import { configuredCli } from '../externals/remote-git/index.js';
import { isYanError } from '../util/error.js';
import { action, out } from './shared/action.js';
import { agentSpecFor, cliKind, configPath, readScenarios, resolveShift, runsAs, type AgentSpec } from './shared/config.js';
import { registry } from './shared/repo.js';

/**
 * `yan doctor` — can this machine run yan? Every check is local: none of them
 * reaches the network, so this answers offline.
 *
 * Only the host CLI the configuration names is checked, never both.
 */

interface Report {
  ok: number;
  warn: number;
  fail: number;
}

function line(report: Report, state: 'ok' | 'warn' | 'fail', name: string, detail: string): void {
  report[state] += 1;
  const mark = state === 'ok' ? 'ok  ' : state === 'warn' ? 'WARN' : 'FAIL';
  out(`  ${mark}  ${name.padEnd(16)}${detail}`);
}

/**
 * Where a command is, or `undefined`. Honours `PATHEXT` on Windows, so `gh`
 * finds `gh.exe` and `claude` finds `claude.cmd`. Needs no shell.
 */
function which(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    try {
      return statSync(command).isFile() ? command : undefined;
    } catch {
      return undefined;
    }
  }
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
      : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* next candidate */ }
    }
  }
  return undefined;
}

function gitConfig(scope: '--global' | '--system', key: string): string {
  const r = spawnSync('git', ['config', scope, key], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

/**
 * A commit identity in `--global` or `--system`, never a repository's own —
 * that is the only kind a leased worktree can see. Reports, never fixes.
 */
function checkGitIdentity(report: Report): void {
  const name = gitConfig('--global', 'user.name') || gitConfig('--system', 'user.name');
  const email = gitConfig('--global', 'user.email') || gitConfig('--system', 'user.email');
  if (name !== '' && email !== '') {
    line(report, 'ok', 'git identity', `${name} <${email}>`);
    return;
  }
  line(report, 'fail', 'git identity',
    "no global user.name/user.email - every shift commits in a leased worktree, which sees only the global config, so its commit would fail after the work is done. Run: git config --global user.name '<you>' && git config --global user.email '<you@example.com>'",
  );
}

function checkRequired(report: Report): void {
  const git = which('git');
  if (git === undefined) line(report, 'fail', 'git', 'not on PATH - install git and retry');
  else line(report, 'ok', 'git', git);

  // node is obviously present; what matters is whether it is on PATH for the
  // hooks and panes that will look for it by name.
  const onPath = which('node');
  line(report, onPath === undefined ? 'warn' : 'ok', 'node',
    onPath === undefined
      ? `${process.version} at ${process.execPath}, but 'node' is not on PATH - the Stop hooks and any pane that starts yan by name will not find it`
      : `${process.version} (${onPath})`,
  );

  checkGitIdentity(report);
}

/**
 * The vault this machine works in, and how its checkout stands against
 * `origin/main` as the last fetch left it — nothing here fetches.
 */
function checkVault(report: Report): void {
  const dir = vaultDirIfAny();
  if (dir === undefined) {
    const active = activeVaultName();
    line(report, 'fail', 'vault',
      active === undefined
        ? `none registered in ${machineConfigPath()} - 'yan vault init <name> --remote <url>', or 'yan vault clone <url>'`
        : `'${active}' is active but does not resolve to a vault - 'yan vault ls' shows what is registered`,
    );
  } else {
    const identity = readVaultJson(dir);
    line(report, identity.version > VAULT_VERSION ? 'fail' : 'ok', 'vault',
      identity.version > VAULT_VERSION
        ? `${dir} was written by a newer yan (vault.json version ${identity.version}) - update this clone`
        : `${identity.name === '' ? '(unnamed)' : identity.name} → ${dir}`,
    );

    const origin = remoteUrl(dir);
    if (origin === undefined) {
      line(report, 'warn', 'vault remote', 'no origin - this vault is local only, so nothing is backed up');
    } else {
      const counts = gitOut(dir, ['rev-list', '--left-right', '--count', 'origin/main...HEAD']).trim();
      const [behind = '?', ahead = '?'] = counts.split(/\s+/);
      line(report, 'ok', 'vault remote', `${origin}  ${ahead} ahead / ${behind} behind, as of the last fetch`);
    }
  }

  const root = cloneRoot();
  line(report, root === undefined ? 'warn' : 'ok', 'clone_root',
    root ?? `unset in ${machineConfigPath()} - 'yan repo add <url>' has nowhere to clone into`,
  );

  // The row that earns its place on a machine that just cloned a vault: every
  // repository is registered and none of them is anywhere yet, and without this
  // the first thing you meet is a command failing for what looks like an
  // unrelated reason.
  const repos = registry();
  const missing = repos.filter((r) => r.path === undefined).map((r) => r.name);
  if (repos.length === 0) {
    line(report, 'warn', 'repos', "none registered - 'yan repo add' in the directory where your clones live");
  } else {
    line(report, missing.length > 0 ? 'warn' : 'ok', 'repos',
      missing.length > 0
        ? `${repos.length} registered, ${repos.length - missing.length} linked here - no path on this machine for: ${missing.join(', ')}`
        : `${repos.length} registered, all linked on this machine`,
    );
  }
}

/** Whether `yan` is on PATH so you can run it from any directory. */
function checkYanOnPath(report: Report): void {
  const home = yanHome();
  const found = which('yan');
  if (found === undefined) {
    line(report, 'warn', 'yan on PATH',
      `not found - run 'npm link' in ${home}, then open a new terminal`);
    return;
  }
  line(report, 'ok', 'yan on PATH', found);
}

/** How a CLI runs, in one phrase: `claude opus high`. */
function describeSpec(spec: AgentSpec): string {
  return runsAs(spec);
}

/** One configured CLI: on PATH, and able to take the model and effort it was given. */
function checkCli(report: Report, label: string, spec: AgentSpec, suffix = ''): void {
  const found = which(cliKind(spec.cli));
  const known = ['claude', 'codex', 'agy'].includes(cliKind(spec.cli));
  if (!known && (spec.model !== '' || spec.effort !== '')) {
    line(report, 'warn', label, `${describeSpec(spec)} - yan does not know how to pass a model or effort to '${cliKind(spec.cli)}', so both are ignored`);
  } else if (found === undefined) {
    line(report, 'warn', label, `${describeSpec(spec)}${suffix} - '${cliKind(spec.cli)}' is not on PATH yet`);
  } else {
    line(report, 'ok', label, `${describeSpec(spec)}${suffix} (${found})`);
  }
}

/**
 * `agents.*` and `scenarios`. Returns every CLI a role can run, keyed by role:
 * `yan`, `shift`, and `shift:<scenario>/<tier>` for each tier.
 */
function checkConfig(report: Report): { agents: Record<string, string> } {
  const path = configPath();
  const parsed = readJsonIfPresent(path);
  if (parsed === undefined) {
    line(report, 'fail', 'config.json', `missing or not valid JSON - the vault's config.json is where agents.*, scenarios and remote_git.* live; copy templates/vault/config.example.json to ${path}`);
    return { agents: {} };
  }
  line(report, 'ok', 'config.json', path);

  const agents: Record<string, string> = {};
  for (const role of ['yan', 'shift']) {
    const spec = agentSpecFor(role);
    if (spec.cli === '') {
      line(report, 'fail', `agents.${role}`, `not set in ${path}`);
      continue;
    }
    agents[role] = spec.cli;
    checkCli(report, `agents.${role}`, spec);
  }

  const { scenarios, problems } = readScenarios();
  for (const problem of problems) line(report, 'fail', 'scenarios', `${problem} - shift new refuses what it cannot resolve`);
  for (const scenario of scenarios) {
    for (const tier of scenario.tiers) {
      const spec = resolveShift('doctor', scenario.name, tier.name);
      agents[`shift:${scenario.name}/${tier.name}`] = spec.cli;
      checkCli(report, `${scenario.name}/${tier.name}`, spec, tier.name === scenario.defaultTier ? ', default' : '');
    }
  }
  return { agents };
}

/** The host CLI the configuration names, checked for presence only. */
function checkRemoteHost(report: Report): void {
  let cli: 'gh' | 'glab';
  try {
    cli = configuredCli();
  } catch (err) {
    line(report, 'fail', 'remote host', isYanError(err) ? err.message : String(err));
    return;
  }

  const found = which(cli);
  if (found === undefined) {
    line(report, 'fail', `remote host (${cli})`,
      cli === 'gh'
        ? 'gh not on PATH - install the GitHub CLI (https://cli.github.com)'
        : 'glab not on PATH - install the GitLab CLI (https://gitlab.com/gitlab-org/cli)',
    );
    return;
  }
  line(report, 'ok', `remote host (${cli})`, found);
}

function checkHerdr(report: Report, agents: Record<string, string>): void {
  const version = herdrHealth();
  if (version === undefined) {
    line(report, 'fail', 'herdr', "not answering - install it, or start it, then run 'yan doctor'");
  } else {
    line(report, 'ok', 'herdr', version.version);
    // The generated types are pinned to a protocol; this is where drift shows.
    const drift =
      version.protocol !== HERDR_PROTOCOL || version.schemaVersion !== HERDR_SCHEMA_VERSION;
    line(report, drift ? 'warn' : 'ok', 'protocol',
      drift
        ? `installed ${version.protocol}/${version.schemaVersion}, types generated against ${HERDR_PROTOCOL}/${HERDR_SCHEMA_VERSION} - re-run scripts/generate-herdr-types.mjs`
        : `${version.protocol}, schema ${version.schemaVersion} - matches the generated types`,
    );
  }

  // Empty when herdr did not answer, so every kind reads as not installed.
  const installed = version?.integrations ?? {};
  // Herdr names its integration after the product; `agents.*` names the
  // executable. They agree everywhere but here, and an unmapped kind reports
  // "no integration installed" forever however many times you install it.
  const integrationOf = (kind: string): string =>
    kind === 'agy' ? 'antigravity-cli' : kind;
  const kinds = [
    ...new Set(
      Object.values(agents)
        .filter((v) => v !== '')
        .map((v) => cliKind(v)),
    ),
  ].sort();
  if (kinds.length === 0) {
    line(report, 'warn', 'integrations', 'the vault config names no agents');
  }
  for (const kind of kinds) {
    const name = integrationOf(kind);
    const state = installed[name];
    if (state === undefined) {
      line(report, 'warn', kind,
        `no herdr integration installed - 'herdr integration install ${name}' records the agent's session id`,
      );
    } else {
      line(report, 'ok', kind, `integration ${state}`);
    }
  }
}

/**
 * Codex's first-run gates, read out of `$CODEX_HOME/config.toml`. Silent when
 * no configured agent is codex.
 */
function checkCodex(report: Report, agents: Record<string, string>): void {
  const roles = Object.entries(agents).filter(([, v]) => cliKind(v) === 'codex');
  if (roles.length === 0) return;

  out('');
  out('codex');

  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  let config = '';
  try {
    config = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    line(report, 'warn', 'codex config', `${join(home, 'config.toml')} is not readable - codex has not been run on this machine yet, so both first-run gates are still armed`,
    );
    return;
  }

  // The key is `<path to the hooks file>:<event>:<n>:<n>`; the path spelling is
  // codex's, so the test is on the file, not on an exact key.
  const ours = join(yanHome(), '.codex', 'hooks.json');
  const trusted = config.toLowerCase().includes(`${ours.toLowerCase().replace(/\//g, '\\')}:`);
  const shift = roles.some(([role]) => role.startsWith('shift'));
  const main = roles.some(([role]) => role === 'yan');

  // Only the main agent meets this gate: a shift is dispatched past it.
  line(report, trusted || !main ? 'ok' : 'warn', 'hook review',
    trusted
      ? `${ours} is recorded as trusted`
      : main
        ? `${ours} has never been trusted, so codex will stop on "Hooks need review" and WAIT. Herdr reads that screen as 'idle', not 'blocked', so nothing wakes yan - answer it once in your own pane. It re-arms whenever the file changes`
        : 'shifts pass --dangerously-bypass-hook-trust, so no dispatch meets this prompt',
  );

  if (shift) {
    line(report, 'warn', 'hook trust',
      "agents.shift is codex, so every shift runs with --dangerously-bypass-hook-trust: hooks shipped BY THE REPOSITORY IT IS WORKING IN run without review. That is deliberate - the alternative is a shift parking silently on a prompt Herdr reports as 'idle' - but it is a standing decision about other people's code, and it should be withdrawn once Herdr's manifest learns the prompt",
    );
  }

  line(report, shift ? 'warn' : 'ok', 'directory trust',
    shift
      ? "agents.shift is codex: the first dispatch into each repository stops on \"Do you trust the contents of this directory?\". Herdr does read that as 'blocked', so yan escalates and you answer once per repository - but --dangerously-bypass-approvals-and-sandbox does NOT cover it"
      : 'agents.shift is not codex, so no dispatch meets the directory-trust prompt',
  );
}

/**
 * What agy needs that the other two do not. Silent when no configured agent is
 * agy.
 *
 * Agy has no notion of "the directory I was started in": its working set is
 * the workspace named by `--add-dir`, and with an empty one it invents a
 * project under `~/.gemini` and writes there. Customization discovery follows
 * the same workspace, so `.agents/hooks.json` is found — or not — for exactly
 * the same reason the files land in the right place or the wrong one. One
 * cause, two symptoms, and `yan continue` passes `--add-dir $YAN_HOME` to fix
 * both at once; what is checked here is that the file it goes looking for is
 * actually there.
 */
function checkAgy(report: Report, agents: Record<string, string>): void {
  const roles = Object.entries(agents).filter(([, v]) => cliKind(v) === 'agy');
  if (roles.length === 0) return;

  out('');
  out('agy');

  // The hooks supervise the main agent; a shift on agy needs none of them.
  const main = roles.some(([role]) => role === 'yan');
  if (main) {
    const ours = join(yanHome(), '.agents', 'hooks.json');
    const registered = existsSync(ours);
    line(report, registered ? 'ok' : 'fail', 'hooks.json',
      registered
        ? `${ours} - the autoarm, the guard, and the session-start stand-in`
        : `${ours} is missing, so nothing supervises a turn: no autoarm, no turn-end guard, and no rebuilt picture at startup`,
    );
  }

  // The one screen where agy stops and Herdr does not notice. The main agent
  // meets it in `user`'s own pane, which is why this is a note rather than a
  // warning; a shift meets it unattended, and `Terminal.settle` answers it.
  if (main) {
    line(report, 'ok', 'project trust',
      'the first `yan continue` in a new workspace stops on "Do you trust the contents of this project?". Herdr reads that screen as \'idle\', not \'blocked\', and --dangerously-skip-permissions does NOT cover it - answer it once in your own pane',
    );
  }
}

export const command = new Command('doctor')
  .description('check this machine can run yan')
  .action(
    action('doctor', () => {
      const report: Report = { ok: 0, warn: 0, fail: 0 };

      out('yan doctor');
      out(`  YAN_HOME  ${yanHome()}`);

      out('');
      out('required');
      checkRequired(report);
      checkYanOnPath(report);

      out('');
      out('vault');
      checkVault(report);

      out('');
      out('configuration');
      const { agents } = checkConfig(report);

      out('');
      out('remote host');
      checkRemoteHost(report);

      out('');
      out('herdr');
      checkHerdr(report, agents);
      checkCodex(report, agents);
      checkAgy(report, agents);

      // Said once, plainly, because the natural reading of "integration
      // installed" is exactly wrong for the two agents yan dispatches: at v7
      // the Claude and Codex integrations report session identity only and
      // never push state, so `blocked` and `done` are screen matches either way
      out('');
      out('  note  an installed integration records the agent session id. It does not');
      out('        make agent state authoritative: for claude and codex, Herdr classifies');
      out('        state by matching the screen, so `run/signal` stays the other half of');

      out('');
      out(`${report.ok} ok, ${report.warn} warn, ${report.fail} failed`);
      if (report.fail > 0) process.exitCode = 1;
    }),
  );
