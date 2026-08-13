import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { agentFor, configPath } from './shared/config.js';
import { display, taskTokens, UNIT_TOKEN_NAMES } from './shared/display.js';
import { enterIdentity, enterLockFile } from './shared/enter-lock.js';
import { CommandError } from './shared/errors.js';
import { repoDirIfKnown } from './shared/repo.js';
import { tasksDir, vaultDir } from '../util/vault.js';
import { queueJson } from './ls.js';
import { isTty } from './shared/resolve.js';
import { Terminal } from '../externals/herdr/index.js';
import { Task } from '../records/task/index.js';
import { yanHome } from '../util/home.js';
import { claim, isStale, owner, release } from '../util/lock.js';

/**
 * `yan continue --task <id>` — start the main agent in the pane this was typed
 * in, as a child sharing its stdin, stdout and stderr. Creates no container
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

export interface ContinueOptions {
  task?: string;
  agent?: string;
  json?: boolean;
}

export interface Entered {
  readonly version: 1;
  readonly task: string;
  readonly agent: string;
  /** The pane this yan is in, or empty when it is not running under Herdr. */
  readonly pane: string;
  readonly workspace: string;
  /** False means a live yan already holds this task and nothing was started. */
  readonly started: boolean;
  /** Where that live yan is, when this one refused to become a second. */
  readonly where: string;
}

/** What entering needs from the terminal. `Terminal` is the real one. */
export interface Screen {
  workspaceOfPane(pane: string): string | undefined;
  setWorkspaceTokens(workspace: string, tokens: Record<string, string>): void;
  clearWorkspaceTokens(workspace: string, names: readonly string[]): void;
}

/** Starting the main agent; returns its exit status. */
export type StartMain = (
  cli: string,
  argv: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => number;

export interface EnterDeps {
  readonly terminal?: Screen;
  readonly start?: StartMain;
}

/**
 * The record, available at once, and the blocking half. `run` is absent when a
 * live yan already holds the task; calling it takes over the pane until the
 * agent exits, then clears the tokens and releases the lock.
 */
export interface Session {
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
 */
function harnessArgs(agent: string, addDirs: readonly string[]): string[] {
  const kind = (agent.split(/[\\/]/).pop() ?? agent).replace(/\.exe$/, '');
  const args: string[] = [];
  if (kind === 'claude') {
    for (const d of addDirs) args.push('--add-dir', d);
    args.push('--dangerously-skip-permissions');
  } else if (kind === 'codex') {
    args.push('--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust');
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
 * @throws CommandError `usage` when no task is named, the task does not exist,
 *   or no main agent is configured.
 */
export function enterTask(options: ContinueOptions, deps: EnterDeps = {}): Session {
  const id = options.task ?? '';
  if (id === '') {
    throw CommandError.usage('continue', "which task? pass 'yan continue <id>' or 'yan continue --task <id>'. Choosing from the incomplete tasks interactively needs a terminal; 'yan ls' lists them",
    );
  }
  if (!Task.exists(id)) {
    throw CommandError.usage('continue', `no such task: ${id} - 'yan ls' lists the tasks in ${tasksDir()}`,
    );
  }

  const agent = options.agent !== undefined && options.agent !== '' ? options.agent : agentFor('yan');
  if (agent === '') {
    throw CommandError.usage('continue', `no main agent configured - set agents.yan in ${configPath()}, or pass --agent`,
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
          where,
        },
      };
    }
  }

  const terminal = deps.terminal ?? new Terminal();
  const workspace = pane === '' ? undefined : terminal.workspaceOfPane(pane);
  if (workspace !== undefined) {
    display('could not label the workspace', () => {
      terminal.setWorkspaceTokens(workspace, taskTokens(id));
    });
  }

  const argv = harnessArgs(agent, addDirsFor(record));
  const start = deps.start ?? startMain;

  return {
    record: {
      version: 1,
      task: id,
      agent,
      pane,
      workspace: workspace ?? '',
      started: true,
      where: '',
    },
    run: () => {
      try {
        return start(agent, argv, {
          cwd,
          // Explicit, so `yan vault use` elsewhere cannot move a running agent.
          env: { ...process.env, YAN_HOME: cwd, YAN_VAULT: vaultDir(), YAN_TASK: id },
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

/**
 * `given`, or a task chosen from the incomplete ones when there is a tty. With
 * no tty it hands `given` straight back for `enterTask` to refuse.
 *
 * @throws CommandError `usage` when there is nothing incomplete to offer.
 */
async function chooseWhenMissing(given: string): Promise<string> {
  if (given !== '' || !isTty()) return given;

  const queue = queueJson() as {
    tasks: { id: string; title: string; complete: boolean; units: unknown[]; shifts: number }[];
  };
  const live = queue.tasks.filter((t) => !t.complete);
  if (live.length === 0) {
    throw CommandError.usage('continue', "there are no incomplete tasks to continue - 'yan task new' starts one");
  }

  const { chooseTask } = await import('../ui/prompts.js');
  return chooseTask(
    live.map((t) => ({ id: t.id, title: t.title, units: t.units.length, shifts: t.shifts })),
  );
}

/** Print the enter record for a person. */
export function renderEntered(record: Entered): void {
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
  .argument('[task-id]')
  .option('--task <id>', 'the task to continue')
  .option('--agent <cli>', 'override agents.yan for this run')
  .option('--json', 'print what happened instead of a summary')
  .addHelpText(
    'after',
    `
usage: yan continue <task-id> [--agent <cli>] [--json]
       yan continue --task <task-id> [--agent <cli>] [--json]

Starts the main agent in THIS pane. No workspace is created and there is
nothing to join: yan is already in the multiplexer \`user\` is already in.

A second yan on the same task is refused: when one is already running this
says where it is rather than spawning a duplicate.

With no id and a terminal, this asks which of the incomplete tasks to open.
Without a terminal it refuses: pass --task <id>.`,
  )
  .action(
    action('yan continue', async (positional: string | undefined, options: ContinueOptions) => {
      if (positional !== undefined && positional !== '' && options.task !== undefined && options.task !== '') {
        throw CommandError.usage('continue', 'only one task id may be given');
      }
      const session = enterTask({
        ...options,
        task: await chooseWhenMissing(options.task ?? positional ?? ''),
      });
      const { record } = session;

      if (options.json === true) out(JSON.stringify(record));
      else renderEntered(record);

      if (session.run !== undefined) {
        process.exitCode = session.run();
      }
    }),
  );
