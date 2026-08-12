import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
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
import { configPath } from './shared/config.js';
import { registry } from './shared/repo.js';

/**
 * `yan doctor` — can this machine run yan?
 *
 * Until this phase the command was half of one: the TypeScript half checked
 * Herdr and shelled out to `bin/yan-doctor.sh` for everything else. Phase 8
 * empties `bin/` of commands, so the rest of the checklist arrives here — and
 * three of its rows do not, because they are checks on a runtime yan no longer
 * has:
 *
 *   jq       retired with the shell that needed it (plan/conventions.md §2)
 *   backend  there is one terminal, and it is Herdr; the `backend` config key
 *            and its fail-closed branches are Phase 9's to remove
 *   winpty   a native process in a Herdr pane gets a real console
 *            (evidence.md §3), so the whole reason for it is gone
 *
 * ONE RULE WORTH RESTATING, because it is the one a tidy-up breaks: only the
 * CLI named by the configured host kind is checked, never both. A machine that
 * delivers to GitHub has no reason to install `glab`, and reporting its absence
 * as a problem trains people to ignore doctor.
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
 * Where a command is, or `undefined`.
 *
 * `command -v`'s job, done without a shell — doctor runs on both runtimes and
 * must not need one of them to answer. `PATHEXT` is why this is not one line:
 * on Windows `gh` is `gh.exe` and `claude` is often `claude.cmd`.
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
 * A commit identity every leased worktree can see.
 *
 * Every shift commits, and it commits in a worktree under `~/.yan-trees` —
 * not in this checkout and not in the main clone. An identity that lives only
 * in a repository's own `.git/config` is therefore invisible where it is
 * needed, and `git commit` fails with "Please tell me who you are" after the
 * work is already done.
 *
 * Found on the machine yan was built on: Git Bash had no global identity at
 * all, while the checkout had a local one — which reads as perfectly healthy
 * from inside the checkout. So this asks `--global` and `--system`
 * deliberately, and never the repository.
 *
 * yan does not fix it: writing git config is `user`'s decision. Doctor reports
 * it and says what to run.
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

  // node cannot be missing here — it is running this — so what is worth
  // reporting is WHICH one, and whether the same one is on PATH for the hooks
  // and the panes that will look for it by name.
  const onPath = which('node');
  line(report, onPath === undefined ? 'warn' : 'ok', 'node',
    onPath === undefined
      ? `${process.version} at ${process.execPath}, but 'node' is not on PATH - the Stop hooks and any pane that starts yan by name will not find it`
      : `${process.version} (${onPath})`,
  );

  checkGitIdentity(report);
}

/**
 * The vault this machine works in (v3 td cli.md §3).
 *
 * "Registered but not resolving" is the row that earns its place: it is the
 * normal state of a fresh install and of a vault whose directory moved, and it
 * is the state in which every other command fails with a message about
 * something else.
 *
 * The remote row is deliberately LOCAL-ONLY — `origin/main` as the last fetch
 * left it. Doctor has to answer on a train, and a check that reaches the
 * network is one people learn to skip.
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

function checkConfig(report: Report): { agents: Record<string, unknown> } {
  const path = configPath();
  const parsed = readJsonIfPresent(path);
  if (parsed === undefined) {
    line(report, 'fail', 'config.json', `missing or not valid JSON - the vault's config.json is where agents.* and remote_git.* live; copy templates/vault/config.json to ${path}`);
    return { agents: {} };
  }
  line(report, 'ok', 'config.json', path);

  const root = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const agents = (typeof root.agents === 'object' && root.agents !== null ? root.agents : {}) as Record<string, unknown>;
  for (const role of ['yan', 'shift']) {
    const value = agents[role];
    if (typeof value !== 'string' || value === '') {
      line(report, 'fail', `agents.${role}`, `not set in ${path}`);
      continue;
    }
    // The value may carry trailing argv; the executable is the first word.
    const cli = value.trim().split(/\s+/)[0] as string;
    const found = which(cli);
    if (found === undefined) line(report, 'warn', `agents.${role}`, `'${value}' is not on PATH yet`);
    else line(report, 'ok', `agents.${role}`, `${value} (${found})`);
  }
  return { agents };
}

/** ONLY the CLI the configured kind names. Never both. */
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
  // Presence, and not whether it is logged in. Asking `glab auth status`
  // reaches the network, and doctor has to answer on a train; a host that
  // refuses us is reported by the command that actually needed it.
  line(report, 'ok', `remote host (${cli})`, found);
}

function checkHerdr(report: Report, agents: Record<string, unknown>): void {
  const version = herdrHealth();
  if (version === undefined) {
    line(report, 'fail', 'herdr', "not answering - install it, or start it, then run 'yan doctor'");
  } else {
    line(report, 'ok', 'herdr', version.version);
    // A version check, and only a version check. Herdr ships on a preview
    // channel with no API stability promise, so the generated types are pinned
    // to a protocol and this is where drift is noticed (runtime.md §4,
    // sources.md §2).
    const drift =
      version.protocol !== HERDR_PROTOCOL || version.schemaVersion !== HERDR_SCHEMA_VERSION;
    line(report, drift ? 'warn' : 'ok', 'protocol',
      drift
        ? `installed ${version.protocol}/${version.schemaVersion}, types generated against ${HERDR_PROTOCOL}/${HERDR_SCHEMA_VERSION} - re-run scripts/generate-herdr-types.mjs and re-check docs/v2/td/evidence.md §9`
        : `${version.protocol}, schema ${version.schemaVersion} - matches the generated types`,
    );
  }

  // Empty when herdr did not answer at all; the failure is already reported
  // above, and every kind then reads as "no integration installed".
  const installed = version?.integrations ?? {};
  const kinds = [
    ...new Set(
      Object.values(agents)
        .filter((v): v is string => typeof v === 'string' && v !== '')
        .map((v) => v.trim().split(/\s+/)[0] as string),
    ),
  ].sort();
  if (kinds.length === 0) {
    line(report, 'warn', 'integrations', 'the vault config names no agents');
  }
  for (const kind of kinds) {
    const state = installed[kind];
    if (state === undefined) {
      line(report, 'warn', kind,
        `no herdr integration installed - 'herdr integration install ${kind}' records the agent's session id`,
      );
    } else {
      line(report, 'ok', kind, `integration ${state}`);
    }
  }
}

/**
 * Codex's first-run gates, reported where they can still be answered.
 *
 * Both were measured against codex-cli 0.147.0 in Phase 8.5, and the second is
 * the one that matters: codex parks on "Hooks need review" and Herdr classifies
 * that screen as `idle`, so an unattended shift hangs there and nothing wakes.
 * A person finding this out by dispatching finds it out hours later.
 *
 * The hook-trust half is a real check rather than a leaflet: codex records
 * trust per hooks file in `[hooks.state]`, keyed by path, so whether yan's own
 * `.codex/hooks.json` has ever been trusted is answerable from disk.
 */
function checkCodex(report: Report, agents: Record<string, unknown>): void {
  const roles = Object.entries(agents).filter(
    ([, v]) => typeof v === 'string' && (v.trim().split(/\s+/)[0] ?? '') === 'codex',
  );
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
  const shift = roles.some(([role]) => role === 'shift');
  const main = roles.some(([role]) => role !== 'shift');

  // A shift is dispatched with --dangerously-bypass-hook-trust, so it never
  // meets this gate; the main agent is not, because it runs in a pane `user` is
  // watching and can answer it. So the same unanswered prompt is a warning for
  // one role and irrelevant to the other.
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

      // Said once, plainly, because the natural reading of "integration
      // installed" is exactly wrong for the two agents yan dispatches: at v7
      // the Claude and Codex integrations report SESSION IDENTITY ONLY and
      // never push state, so `blocked` and `done` are screen matches either way
      // (sources.md §4.1, evidence.md §8).
      out('');
      out('  note  an installed integration records the agent session id. It does not');
      out('        make agent state authoritative: for claude and codex, Herdr classifies');
      out('        state by matching the screen, so `run/signal` stays the other half of');
      out('        the pair (docs/v2/td/terminal.md §6).');

      out('');
      out(`${report.ok} ok, ${report.warn} warn, ${report.fail} failed`);
      if (report.fail > 0) process.exitCode = 1;
    }),
  );
