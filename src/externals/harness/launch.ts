import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How each agent CLI yan runs is started, and what it keeps around it: the
 * flags that pick a model and an effort, the argv that runs it unattended,
 * whether its opening prompt rides in that argv, and the files `yan doctor`
 * looks at. One section per CLI.
 *
 * This only answers "what is the argv". Nothing here starts a process: the
 * main agent is spawned by `yan continue`, a shift by Herdr for `yan shift new`.
 *
 * Every CLI runs unattended, the main agent included. A shift works in a pane
 * nobody is watching, and a shift's report is typed into the main agent's pane
 * and starts a turn with nobody watching either; a permission prompt raised
 * then stalls whoever is meant to answer it.
 */

/** What one agent is started with. */
export interface Launch {
  /** Empty for the CLI's own default. */
  readonly model: string;
  readonly effort: string;
  /** Where it starts: a shift's tree or scope path, yan's own clone for the main agent. */
  readonly workdir: string;
  /** The other directories it may touch. */
  readonly addDirs: readonly string[];
  /**
   * A shift that delivers a report rather than a merge request: `explore` and
   * `uix`. It runs unattended too. Read-only by permission mode is the one
   * thing it must not be: claude's `--permission-mode plan` ends at "ready to
   * execute - would you like to proceed?", an approval nobody is there to
   * give, so every scout parked there and delivered nothing. What keeps it
   * from pushing is its brief, plus a flag that makes the obvious way to do it
   * fail; what makes that affordable is that its tree is thrown away and its
   * branch is never pushed. The gain is that it can run the build and the test
   * suite it is reporting on.
   */
  readonly readOnly?: boolean;
  /** The opening prompt. Only a CLI whose `promptInArgv` is true puts it in argv. */
  readonly prompt?: string;
}

interface Harness {
  /** Herdr's name for its integration with this CLI, which is not always the executable's. */
  readonly integration: string;
  /** yan's own hook file for this CLI, relative to yan's clone. */
  readonly hooksFile: string;
  /** Whether `launchArgs` carries the opening prompt. When not, it is typed in once the CLI is up. */
  readonly promptInArgv: boolean;
  modelFlags(model: string, effort: string): string[];
  /** Everything after the executable, the model flags first. */
  launchArgs(launch: Launch): string[];
}

// --- claude ------------------------------------------------------------------

/**
 * The work order is not in argv, for claude or codex: Herdr's `agent start`
 * returns only when the agent is ready for input, and one started with its
 * prompt in argv goes straight to work and is still working at the deadline -
 * every shift came back as `timeout`. It is typed in once the harness is up.
 */
function dashDashModel(model: string, effort: string): string[] {
  const args: string[] = [];
  if (model !== '') args.push('--model', model);
  if (effort !== '') args.push('--effort', effort);
  return args;
}

const claude: Harness = {
  integration: 'claude',
  hooksFile: join('.claude', 'settings.json'),
  promptInArgv: false,
  modelFlags: dashDashModel,
  launchArgs(launch) {
    const args = dashDashModel(launch.model, launch.effort);
    for (const d of launch.addDirs) args.push('--add-dir', d);
    args.push('--dangerously-skip-permissions');
    if (launch.readOnly === true) args.push('--disallowed-tools', 'Bash(git push:*)');
    return args;
  },
};

// --- codex -------------------------------------------------------------------

function codexModel(model: string, effort: string): string[] {
  const args: string[] = [];
  if (model !== '') args.push('-m', model);
  // A bare value is taken as a literal string when it is not TOML.
  if (effort !== '') args.push('-c', `model_reasoning_effort=${effort}`);
  return args;
}

const codex: Harness = {
  integration: 'codex',
  hooksFile: join('.codex', 'hooks.json'),
  promptInArgv: false,
  modelFlags: codexModel,
  launchArgs(launch) {
    const args = codexModel(launch.model, launch.effort);
    if (launch.readOnly === true) args.push('--sandbox', 'read-only');
    else args.push('--dangerously-bypass-approvals-and-sandbox');

    // Hooks the target repository ships run without review. Codex's
    // hook-review prompt is one Herdr classifies as `idle`, so a shift that
    // met it would park in an unfocused pane and never wake anybody.
    // `user` took this decision knowing what it costs.
    args.push('--dangerously-bypass-hook-trust');
    return args;
  },
};

/** Codex's own settings, where it records which hook files it trusts. */
export function codexConfigFile(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
}

/**
 * Whether codex's settings, as text, record `hooksFile` as trusted. The key is
 * `<path to the hooks file>:<event>:<n>:<n>`; the path spelling is codex's, so
 * the test is on the file, not on an exact key.
 *
 * Written for codex's Windows spelling, with backslashes. macOS and Linux are
 * unverified: if codex writes `/` in the key there, this never matches and
 * doctor warns about hooks that are in fact trusted.
 */
export function codexTrustsHooks(config: string, hooksFile: string): boolean {
  return config.toLowerCase().includes(`${hooksFile.toLowerCase().replace(/\//g, '\\')}:`);
}

// --- agy ---------------------------------------------------------------------

/**
 * Agy ignores the directory it starts in: its working set is the workspace
 * `--add-dir` names, and with an empty one it invents a project under
 * `~/.gemini` and writes there instead. So the working directory goes on the
 * list too - for the main agent that is yan's own clone, and a yan that cannot
 * see its own `dist/` is a yan that cannot run a hook.
 *
 * Agy keeps its prompt on the command line, because `-i` is what makes it act
 * on one and then stay open.
 */
const agy: Harness = {
  integration: 'antigravity-cli',
  hooksFile: join('.agents', 'hooks.json'),
  promptInArgv: true,
  modelFlags: dashDashModel,
  launchArgs(launch) {
    const args = dashDashModel(launch.model, launch.effort);
    for (const d of [launch.workdir, ...launch.addDirs]) args.push('--add-dir', d);
    args.push('--dangerously-skip-permissions');
    if (launch.prompt !== undefined) args.push('-i', launch.prompt);
    return args;
  },
};

// --- by name -----------------------------------------------------------------

/** The CLIs yan knows how to start. */
export type HarnessKind = 'claude' | 'codex' | 'agy';

const HARNESSES: ReadonlyMap<string, Harness> = new Map<HarnessKind, Harness>([
  ['claude', claude],
  ['codex', codex],
  ['agy', agy],
]);

/** The executable's name without directory or `.exe`: `claude`, `codex`, `agy`. */
export function cliKind(cli: string): string {
  const first = cli.trim().split(/\s+/)[0] ?? '';
  return (first.split(/[\\/]/).pop() ?? first).replace(/\.exe$/, '');
}

function harnessOf(cli: string): Harness | undefined {
  return HARNESSES.get(cliKind(cli));
}

/** Whether yan knows how to start `cli`. */
export function isKnownCli(cli: string): boolean {
  return harnessOf(cli) !== undefined;
}

/**
 * The flags that set a model and an effort, in the spelling `cli` takes.
 * `[]` for a CLI yan does not know, which `yan doctor` reports.
 */
export function modelFlags(cli: string, spec: { readonly model: string; readonly effort: string }): string[] {
  return harnessOf(cli)?.modelFlags(spec.model, spec.effort) ?? [];
}

/**
 * The whole argv `cli` needs after its executable, for the main agent and a
 * shift alike: they differ only in `readOnly` and `prompt`. `[]` for a CLI yan
 * does not know.
 */
export function launchArgs(cli: string, launch: Launch): string[] {
  return harnessOf(cli)?.launchArgs(launch) ?? [];
}

/** Whether `launchArgs` carries the opening prompt; when not, the caller types it in. */
export function promptInArgv(cli: string): boolean {
  return harnessOf(cli)?.promptInArgv ?? false;
}

/** Herdr's name for its integration with `cli`: the executable's, unless Herdr names it otherwise. */
export function herdrIntegration(cli: string): string {
  return harnessOf(cli)?.integration ?? cliKind(cli);
}

/** yan's hook file for `kind` in the clone at `yanHome`. */
export function hooksFile(kind: HarnessKind, yanHome: string): string {
  return join(yanHome, (HARNESSES.get(kind) as Harness).hooksFile);
}
