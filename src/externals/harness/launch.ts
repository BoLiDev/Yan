/**
 * How each agent CLI `yan` starts is spelled: the flags that pick a model and
 * an effort, the flag that skips its approvals, and how it takes the opening
 * prompt. One section per CLI. This only answers "what is the argv";
 * `cli/shared/launch.ts` runs it.
 *
 * The opening prompt goes where the CLI lets it go without a reply: claude's
 * system prompt, codex's developer instructions. agy has neither, so it gets
 * the prompt as its first message, with a line asking it to wait.
 *
 * Hooks go in for the one session, never into a CLI's own config: claude's
 * `--settings`, codex's `-c`. agy reads hooks only from files, its global one
 * or one in the workspace, which would leave the tree dirty, so it has none.
 */

/** What one agent is started with. */
export interface Launch {
  /** Empty for the CLI's own default. */
  readonly model: string;
  readonly effort: string;
  /** Where it starts: the task's first tree, or wherever `user` typed `yan`. */
  readonly workdir: string;
  /** The task's other trees, which it may read and write as well. */
  readonly addDirs: readonly string[];
  /** What it is told before `user` says anything. */
  readonly prompt: string;
  /** Start it with approvals and sandbox bypassed, rather than as its own settings say. */
  readonly skipPermissions: boolean;
  /**
   * Shell commands to run on its lifecycle, for this session only: `prompt`
   * each time `user` sends a message, before the model sees it, and `stop`
   * each time it finishes a turn. A CLI with no such hooks goes without.
   */
  readonly hooks?: { readonly prompt: string; readonly stop: string };
}

/** The line a first message ends with, so a prompt that is not a request starts no work. */
export const WAIT_LINE = 'Nothing to do yet; wait for the user.';

interface Harness {
  modelFlags(model: string, effort: string): string[];
  /** Everything after the executable, the model flags first. */
  launchArgs(launch: Launch): string[];
}

// --- claude ------------------------------------------------------------------

function addDirFlags(dirs: readonly string[]): string[] {
  return dirs.flatMap((d) => ['--add-dir', d]);
}

function dashDashModel(model: string, effort: string): string[] {
  const args: string[] = [];
  if (model !== '') args.push('--model', model);
  if (effort !== '') args.push('--effort', effort);
  return args;
}

/**
 * Hooks go in through `--settings`, which adds to the user's own settings for
 * this session alone, so they never reach a claude started any other way.
 */
function claudeHooks(hooks: Launch['hooks']): string[] {
  if (hooks === undefined) return [];
  const on = (command: string): unknown[] => [{ hooks: [{ type: 'command', command }] }];
  return ['--settings', JSON.stringify({ hooks: { UserPromptSubmit: on(hooks.prompt), Stop: on(hooks.stop) } })];
}

const claude: Harness = {
  modelFlags: dashDashModel,
  launchArgs(launch) {
    const skip = launch.skipPermissions ? ['--dangerously-skip-permissions'] : [];
    return [...dashDashModel(launch.model, launch.effort), ...skip, ...addDirFlags(launch.addDirs), ...claudeHooks(launch.hooks), '--append-system-prompt', launch.prompt];
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

/**
 * Hooks go in as `-c` overrides, for this session alone. Codex runs a hook
 * from a source it has not been told to trust only when its trust check is
 * bypassed, and the bypass covers the session's every hook, a repository's
 * own `.codex/` ones too: the price of hooks that never touch its config.
 */
function codexHooks(hooks: Launch['hooks']): string[] {
  if (hooks === undefined) return [];
  // `-c` parses its value as TOML, and a JSON string is a TOML basic string.
  const on = (command: string): string => `[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;
  return ['--dangerously-bypass-hook-trust', '-c', `hooks.UserPromptSubmit=${on(hooks.prompt)}`, '-c', `hooks.Stop=${on(hooks.stop)}`];
}

const codex: Harness = {
  modelFlags: codexModel,
  launchArgs(launch) {
    const skip = launch.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
    return [
      ...codexModel(launch.model, launch.effort), ...skip, ...addDirFlags(launch.addDirs), ...codexHooks(launch.hooks),
      '-c', `developer_instructions=${JSON.stringify(launch.prompt)}`,
    ];
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
    return [...dashDashModel(launch.model, launch.effort), ...skip, ...addDirFlags([launch.workdir, ...launch.addDirs]), '-i', `${launch.prompt}\n${WAIT_LINE}`];
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
