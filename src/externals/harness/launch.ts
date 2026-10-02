/**
 * How each agent CLI `yan` starts is spelled: the flags that pick a model and
 * an effort, the flag that skips its approvals, and how it takes the opening
 * prompt. One section per CLI. This only answers "what is the argv";
 * `cli/shared/launch.ts` runs it.
 *
 * The opening prompt goes where the CLI lets it go without a reply: claude's
 * system prompt, codex's developer instructions. agy has neither, so it gets
 * the prompt as its first message, with a line asking it to wait.
 */

/** What one agent is started with. */
export interface Launch {
  /** Empty for the CLI's own default. */
  readonly model: string;
  readonly effort: string;
  /** Where it starts: the task's tree, or wherever `user` typed `yan`. */
  readonly workdir: string;
  /** What it is told before `user` says anything. */
  readonly prompt: string;
  /** Start it with approvals and sandbox bypassed, rather than as its own settings say. */
  readonly skipPermissions: boolean;
}

/** The line a first message ends with, so a prompt that is not a request starts no work. */
export const WAIT_LINE = 'Nothing to do yet; wait for the user.';

interface Harness {
  modelFlags(model: string, effort: string): string[];
  /** Everything after the executable, the model flags first. */
  launchArgs(launch: Launch): string[];
}

// --- claude ------------------------------------------------------------------

function dashDashModel(model: string, effort: string): string[] {
  const args: string[] = [];
  if (model !== '') args.push('--model', model);
  if (effort !== '') args.push('--effort', effort);
  return args;
}

const claude: Harness = {
  modelFlags: dashDashModel,
  launchArgs(launch) {
    const skip = launch.skipPermissions ? ['--dangerously-skip-permissions'] : [];
    return [...dashDashModel(launch.model, launch.effort), ...skip, '--append-system-prompt', launch.prompt];
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
  modelFlags: codexModel,
  launchArgs(launch) {
    const skip = launch.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
    // `-c` parses its value as TOML, and a JSON string is a TOML basic string.
    return [...codexModel(launch.model, launch.effort), ...skip, '-c', `developer_instructions=${JSON.stringify(launch.prompt)}`];
  },
};

// --- agy ---------------------------------------------------------------------

/**
 * Agy ignores the directory it starts in: its working set is the workspace
 * `--add-dir` names, and with none it invents a project under `~/.gemini`.
 * `-i` sends the prompt as the first message and stays open.
 */
const agy: Harness = {
  modelFlags: dashDashModel,
  launchArgs(launch) {
    const skip = launch.skipPermissions ? ['--dangerously-skip-permissions'] : [];
    return [...dashDashModel(launch.model, launch.effort), ...skip, '--add-dir', launch.workdir, '-i', `${launch.prompt}\n${WAIT_LINE}`];
  },
};

// --- by name -----------------------------------------------------------------

/** The CLIs yan knows how to start. */
export const HARNESS_KINDS = ['claude', 'codex', 'agy'] as const;

const HARNESSES: ReadonlyMap<string, Harness> = new Map<string, Harness>([
  ['claude', claude],
  ['codex', codex],
  ['agy', agy],
]);

/** The executable's name without directory or `.exe`: `claude`, `codex`, `agy`. */
export function cliKind(cli: string): string {
  const first = cli.trim().split(/\s+/)[0] ?? '';
  return (first.split(/[\\/]/).pop() ?? first).replace(/\.exe$/, '');
}

/** Whether yan knows how to start `cli`. */
export function isKnownCli(cli: string): boolean {
  return HARNESSES.has(cliKind(cli));
}

/**
 * The whole argv `cli` needs after its executable; `[]` for a CLI yan does
 * not know, which the caller refuses before it gets here.
 */
export function launchArgs(cli: string, launch: Launch): string[] {
  return HARNESSES.get(cliKind(cli))?.launchArgs(launch) ?? [];
}
