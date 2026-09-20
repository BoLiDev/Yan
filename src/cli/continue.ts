import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { agentSpecFor, cliKind, configPath, modelFlags, type AgentSpec } from './shared/config.js';
import { display, taskTokens, UNIT_TOKEN_NAMES } from './shared/display.js';
import { enterIdentity, enterLockFile } from './shared/enter-lock.js';
import { repoDirIfKnown } from './shared/repo.js';
import { chosenTask } from './shared/task-id.js';
import { tasksDir, vaultDir } from '../util/vault.js';
import { isTty } from './shared/resolve.js';
import { Terminal } from '../externals/herdr/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { claim, isStale, owner, release } from '../util/lock.js';
import { YanError } from '../util/error.js';

/**
 * `yan continue <id>` — start the main agent in the pane this was typed in, as a child sharing its stdin, stdout and stderr. Creates no container
 * and focuses nothing.
 *
 * One yan per task: a per-task lock, whose live pid is the fact, holds for
 * exactly as long as the agent runs. A second `yan continue` on the same task
 * starts nothing and reports where the live one is; a lock whose owner is gone
 * is reclaimed.
 *
 * The workspace tokens are set before the agent starts and withdrawn when it
 * returns, so a yan killed outright leaves stale ones until the next
 * `yan continue` on that task overwrites them.
 *
 * Exit codes: 0 fine (including "already running, here is where"), 2 you
 * called this wrongly, otherwise the main agent's own status.
 */

interface ContinueOptions {
  task?: string;
  agent?: string;
  json?: boolean;
}

interface Entered {
  readonly version: 1;
  readonly task: string;
  readonly agent: string;
  /** The pane this yan is in, or empty when it is not running under Herdr. */
  readonly pane: string;
  readonly workspace: string;
  /** False means nothing was started; `refused` says what stopped it. */
  readonly started: boolean;
  /**
   * Why nothing was started: `live-yan` is another yan holding this task,
   * `no-terminal` is a stdio the main agent cannot take over. Empty when it
   * did start.
   */
  readonly refused: 'live-yan' | 'no-terminal' | '';
  /** Where the live yan is, when this one refused to become a second. */
  readonly where: string;
}

/** What entering needs from the terminal. `Terminal` is the real one. */
interface Screen {
  workspaceOfPane(pane: string): string | undefined;
  setWorkspaceTokens(workspace: string, tokens: Record<string, string>): void;
  clearWorkspaceTokens(workspace: string, names: readonly string[]): void;
}

/** Starting the main agent; returns its exit status. */
type StartMain = (
  cli: string,
  argv: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => number;

interface EnterDeps {
  readonly terminal?: Screen;
  readonly start?: StartMain;
  /** Whether this stdio is a terminal; the real one reads `process.stdin`. */
  readonly tty?: () => boolean;
}

/**
 * The record, available at once, and the blocking half. `run` is absent when a
 * live yan already holds the task; calling it takes over the pane until the
 * agent exits, then clears the tokens and releases the lock.
 */
interface Session {
  readonly record: Entered;
  readonly run?: () => number;
}

const startMain: StartMain = (cli, argv, options) =>
  spawnSync(cli, [...argv], {
    stdio: 'inherit',
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
  }).status ?? 1;

/**
 * The flags the main agent's harness needs: the extra directories, and running
 * unattended. Unattended even though `user` is at the pane, because the Stop
 * hook wakes this agent between turns with nobody watching, and a permission
 * prompt raised then stalls the thing that does the noticing.
 *
 * Agy needs one thing the other two do not: `home` on the `--add-dir` list.
 * Claude and Codex take the directory they were started in as the root of what
 * they may touch, so `cwd` covers yan's own clone; agy does not look at `cwd`
 * at all. Its working set is the workspace named by `--add-dir`, and with an
 * empty one it invents a project under `~/.gemini` and writes there instead —
 * a yan that cannot see its own `dist/` is a yan that cannot run a hook.
 */
function harnessArgs(spec: AgentSpec, home: string, addDirs: readonly string[]): string[] {
  const kind = cliKind(spec.cli);
  const args: string[] = modelFlags(spec.cli, spec);
  if (kind === 'claude') {
    for (const d of addDirs) args.push('--add-dir', d);
    args.push('--dangerously-skip-permissions');
  } else if (kind === 'codex') {
    args.push('--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust');
  } else if (kind === 'agy') {
    for (const d of [home, ...addDirs]) args.push('--add-dir', d);
    args.push('--dangerously-skip-permissions');
  }
  return args;
}

/** The clones this task's yan may see, in unit order and without repeats. */
function addDirsFor(task: Task): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const unit of task.read().units) {
    if (unit.repo === '' || seen.has(unit.repo)) continue;
    seen.add(unit.repo);
    const clone = repoDirIfKnown(unit.repo);
    if (clone !== undefined) dirs.push(clone);
  }
  return dirs;
}

/**
 * The pane this command is running in, from `$HERDR_PANE_ID` — the one place
 * in yan that reads it. Empty when there is no Herdr around it.
 */
function currentPane(): string {
  const pane = process.env.HERDR_PANE_ID ?? '';
  return pane.trim();
}


/**
 * Take the task's enter lock and prepare its main agent.
 *
 * @throws YanError `continue_usage` when no task is named, the task does not exist,
 *   or no main agent is configured.
 */
export function enterTask(options: ContinueOptions, deps: EnterDeps = {}): Session {
  const id = options.task ?? '';
  if (id === '') {
    throw YanError.usage('continue_usage', "which task? pass 'yan continue <id>'. Choosing from the incomplete tasks interactively needs a terminal; 'yan ls' lists them",
    );
  }
  if (!Task.exists(id)) {
    throw YanError.usage('continue_usage', `no such task: ${id} - 'yan ls' lists the tasks in ${tasksDir()}`,
    );
  }

  const configured = agentSpecFor('yan');
  // `--agent` is `user` picking another CLI for this run; the configured model
  // and effort were meant for the configured one and do not come with it.
  const spec: AgentSpec =
    options.agent !== undefined && options.agent !== '' && options.agent !== configured.cli
      ? { cli: options.agent, model: '', effort: '' }
      : configured;
  const agent = spec.cli;
  if (agent === '') {
    throw YanError.usage('continue_usage', `no main agent configured - set agents.yan in ${configPath()}, or pass --agent`,
    );
  }

  const record = new Task(id);
  // Resolved now rather than inside `run`, which is called much later.
  const cwd = yanHome();
  const pane = currentPane();

  const lock = enterLockFile(id);
  const identity = enterIdentity(id, pane);

  if (!claim(lock, identity)) {
    if (isStale(lock)) {
      release(lock);
    }
    if (!claim(lock, identity)) {
      const held = owner(lock);
      const where = held?.identity ?? '';
      return {
        record: {
          version: 1,
          task: id,
          agent,
          pane,
          workspace: '',
          started: false,
          refused: 'live-yan',
          where,
        },
      };
    }
  }

  // The main agent takes over this stdio, so without a terminal it has nowhere
  // to go: it comes up in print mode, finds nothing on the empty stdin it was
  // handed, and dies naming that instead of this. Asked after the lock, so a
  // task that is already held is reported as held rather than as this; the
  // lock goes straight back, because nothing is going to run under it.
  if (!(deps.tty ?? isTty)()) {
    release(lock);
    return {
      record: {
        version: 1,
        task: id,
        agent,
        pane,
        workspace: '',
        started: false,
        refused: 'no-terminal',
        where: '',
      },
    };
  }

  const terminal = deps.terminal ?? new Terminal();
  const workspace = pane === '' ? undefined : terminal.workspaceOfPane(pane);
  if (workspace !== undefined) {
    display('could not label the workspace', () => {
      terminal.setWorkspaceTokens(workspace, taskTokens(id));
    });
  }

  const argv = harnessArgs(spec, cwd, addDirsFor(record));
  const start = deps.start ?? startMain;

  return {
    record: {
      version: 1,
      task: id,
      agent,
      pane,
      workspace: workspace ?? '',
      started: true,
      refused: '',
      where: '',
    },
    run: () => {
      try {
        return start(agent, argv, {
          cwd,
          // Explicit, so `yan vault use` elsewhere cannot move a running agent.
          env: {
            ...process.env,
            YAN_HOME: cwd,
            YAN_VAULT: vaultDir(),
            YAN_TASK: id,
            // The prompt tells yan its artifacts go in $YAN_TASK_DIR/artifacts;
            // unset, that path lands at the filesystem root.
            YAN_TASK_DIR: record.dir,
          },
        });
      } finally {
        if (workspace !== undefined) {
          display('could not withdraw the workspace tokens', () => {
            terminal.clearWorkspaceTokens(workspace, UNIT_TOKEN_NAMES);
          });
        }
        release(lock);
      }
    },
  };
}

/** Print the enter record for a person. */
export function renderEntered(record: Entered): void {
  if (record.refused === 'no-terminal') {
    out(`nothing was started: there is no terminal on this stdio for ${record.agent} to take over`);
    out(`start    yan continue ${record.task}   (from a pane)`);
    return;
  }
  if (!record.started) {
    out(`yan is already running on task ${record.task} - a second yan on the same task is refused`);
    out(`live     ${record.where === '' ? '(the holder left no pane id)' : record.where}`);
    return;
  }
  out(`task ${record.task}`);
  out(`agent    ${record.agent} starting in this pane${record.pane === '' ? '' : ` (${record.pane})`}`);
}

export const command = new Command('continue')
  .description('start yan for a task, in this pane')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--agent <cli>', 'override agents.yan for this run')
  .option('--json', 'print what happened instead of a summary')
  .addHelpText(
    'after',
    `
Starts the main agent in THIS pane. No workspace is created and there is
nothing to join: yan is already in the multiplexer \`user\` is already in.

A second yan on the same task is refused: when one is already running this
says where it is rather than spawning a duplicate.

With no id and a terminal, this asks which of the tasks in progress to open.
Without a terminal it refuses: pass the id.`,
  )
  .action(
    action('yan continue', async (positional: string | undefined, options: ContinueOptions) => {
      const session = enterTask({
        ...options,
        task: await chosenTask('continue', positional, {
          spelled: 'yan continue',
          question: 'Which task do you want to continue?',
        }),
      });
      const { record } = session;

      if (options.json === true) out(JSON.stringify(record));
      else renderEntered(record);

      if (session.run !== undefined) {
        process.exitCode = session.run();
      } else if (record.refused === 'no-terminal') {
        // Starting the agent is the whole job here, so not doing it is a
        // failure - unlike `yan task new`, where the task was still created.
        process.exitCode = 2;
      }
    }),
  );
