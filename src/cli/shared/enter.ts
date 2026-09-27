import { spawnSync } from 'node:child_process';
import { out } from './action.js';
import { agentSpecFor, type AgentSpec } from './agents.js';
import { launchArgs } from '../../externals/harness/index.js';
import { display, taskTokens, UNIT_TOKEN_NAMES } from './display.js';
import { enterIdentity, enterLockFile } from './enter-lock.js';
import { repoDirIfKnown } from './repo.js';
import { existingTask } from './task-id.js';
import { vaultConfigPath, vaultDir } from '../../util/vault.js';
import { isTty } from './tty.js';
import { Terminal } from '../../externals/herdr/index.js';
import { Task } from '../../records/task/index.js';
import { yanHome } from '../../util/home.js';
import { claim, isStale, owner, release } from '../../util/lock.js';
import { YanError } from '../../util/error.js';

/**
 * Entering a task: taking its enter lock and starting its main agent in this
 * pane. `yan continue` is nothing else, and `yan task new` does it straight
 * after creating the task.
 */

export interface EnterOptions {
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
export function enterTask(options: EnterOptions, deps: EnterDeps = {}): Session {
  const id = options.task ?? '';
  if (id === '') {
    throw YanError.usage('continue_usage', "which task? pass 'yan continue <id>'. Choosing from the incomplete tasks interactively needs a terminal; 'yan ls' lists them",
    );
  }
  existingTask('continue', id);

  const configured = agentSpecFor('yan');
  // `--agent` is `user` picking another CLI for this run; the configured model
  // and effort were meant for the configured one and do not come with it.
  const spec: AgentSpec =
    options.agent !== undefined && options.agent !== '' && options.agent !== configured.cli
      ? { cli: options.agent, model: '', effort: '' }
      : configured;
  const agent = spec.cli;
  if (agent === '') {
    throw YanError.usage('continue_usage', `no main agent configured - set agents.yan in ${vaultConfigPath()}, or pass --agent`,
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

  // Unattended, like a shift, even though `user` is at the pane: see `launchArgs`.
  const argv = launchArgs(agent, { model: spec.model, effort: spec.effort, workdir: cwd, addDirs: addDirsFor(record) });
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
