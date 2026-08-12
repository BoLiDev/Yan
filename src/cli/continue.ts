import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { agentFor, configPath } from './shared/config.js';
import { display, taskTokens, UNIT_TOKEN_NAMES } from './shared/display.js';
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
 * `yan continue --task <id>` — the enter step, and the only one.
 *
 * Yan joins; it does not host.
 *
 * This command starts the main agent in the pane it was typed in, as a child
 * process sharing this process's stdin, stdout and stderr — which are the pane.
 * Nothing is created and nothing is focused.
 *
 * Creating a container to hold the agent is the tempting alternative and it is
 * backwards: Herdr *is* the multiplexer and `user` is already standing in it,
 * so a second one is a tool insisting on its own furniture in someone else's
 * house. There is likewise no "create or join" step — we are already inside.
 *
 * One yan per task, and what answers it.
 *
 * The lock is per task, not per machine. Two yans on two different tasks is
 * ordinary working practice; only a second yan on the same task is refused,
 * because a yan sees one task's files and two of them would both be writing
 * that task's bookkeeping.
 *
 * The lock file's own pid is the fact, which works only because this command
 * lives exactly as long as the main agent it started. `pidAlive` makes it
 * self-healing: a yan killed outright leaves a lock whose pid is gone, and the
 * next `yan continue` reclaims it rather than obeying it.
 *
 * Asking herdr instead does not work, which is worth knowing because it looks
 * like the obvious answer. `agent list` reports every live agent with its pane
 * id, but an agent Herdr detected on screen has no name, and nothing in the
 * listing says which task an agent belongs to. Only an agent started through
 * `agent start` carries a name — and `agent start` needs a pane already sitting
 * at an interactive prompt, which the pane running this command is not.
 *
 * The lock records the pane it was taken in, so a second `yan continue` can say
 * where the live one is instead of spawning a duplicate.
 *
 * What "exits" means.
 *
 * The workspace tokens have to be cleared when yan exits, and clearing needs
 * someone who knows the workspace's lifetime. That is this command: it sets
 * them before the agent starts and withdraws them in the `finally` of the wait.
 * So "yan exits" means, in practice, the main agent process this command
 * Started has terminated — normally, by `/exit`, or by a signal that reaches the whole
 * pane, all of which return from `spawnSync` and run the cleanup.
 *
 * The one case it cannot cover is a yan killed without a chance to run
 * anything, and that is deliberate rather than overlooked: the alternative is a
 * TTL short enough to expire under a session that legitimately lasts all
 * afternoon. Stale tokens are a cosmetic bug, they name the task they belong
 * to, and the next `yan continue` on that task overwrites them.
 *
 * Exit codes: 0 fine (including "already running, here is where"), 2 you called
 * this wrongly, otherwise the main agent's own status.
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

/** Starting the main agent, so a test can drive the enter without a harness. */
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
 * What `enterTask` hands back: the record, and — when an agent is ours to run —
 * the blocking half.
 *
 * Two phases and not one, because the record has to be printable before the
 * pane is handed over. `yan task new --json` reads it, and a record that only
 * arrived after the agent had finished would arrive hours late or never.
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
 * The harness mapping table: a table on purpose, not an abstraction layer. yan
 * itself runs on Claude Code or Codex and nothing else, so it has two rows.
 *
 * Each extra directory is a clone this task actually touches, and anything not
 * listed is invisible to the agent. The working directory is `$YAN_HOME`,
 * because yan runs things in `bin/` and reads `mem/`.
 *
 * Why the main agent gets the same permission flags as a shift.
 *
 * The argument for a shift is that nobody is watching it (see `shift.ts`), and
 * the main agent looks like the opposite case: it is `user`'s own pane, with
 * `user` sitting in front of it. That reasoning is what makes leaving this row
 * empty tempting, and it is wrong.
 *
 * `yan` is not only what `user` types at. The Stop hook arms `yan wait`, and
 * between one turn and the next this agent drains a wake file, dispatches, and
 * clocks a shift out with nobody looking at the pane. A prompt raised in that
 * window stalls exactly as a shift's does — except that what has stalled is the
 * thing that was supposed to be doing the noticing.
 *
 * The prompt was never the boundary either way. What the agent may reach is
 * `$YAN_HOME` plus the clones listed below; work happens in leased trees, and
 * branch protection on the forge is the last line.
 *
 * Codex needs both flags. Without the sandbox flag and the hook-trust flag it
 * meets two first-run gates, and the hook-review gate is the one Herdr reads as
 * `idle` — so nothing wakes and the pane simply sits there. There is no `scout`
 * row here: the main agent is `mr` by nature.
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
 * The pane this command is running in.
 *
 * Herdr injects `HERDR_PANE_ID` into every pane it creates, and this is the one
 * command allowed to read it. Everything else works from explicit ids, because
 * a hook may be handed a sanitised environment and would silently resolve to
 * the wrong pane. `yan continue` is never run by a hook — it is the entry a
 * person types — and what it passes onward is an explicit id either way.
 *
 * Empty when yan is not running under Herdr at all, which is not a failure.
 */
function currentPane(): string {
  const pane = process.env.HERDR_PANE_ID ?? '';
  return pane.trim();
}

function lockFile(id: string): string {
  return join(new Task(id).dir, '.enter.lock');
}

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
  // Resolved once, here. `run` below is called much later — after this command
  // has printed its record, and in `yan task new`'s case from another module —
  // and re-deriving the home at that point would let it answer differently.
  const cwd = yanHome();
  const pane = currentPane();
  const lock = lockFile(id);
  const identity = `yan ${id}${pane === '' ? '' : ` pane=${pane}`}`;

  if (!claim(lock, identity)) {
    // A lock left behind by a process that is gone is reclaimed, not obeyed.
    // Anything else is a live yan, and a second one on the same task is refused.
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
    // Never fatal: the work is correct with ugly
    // labels, and a tool that will not start the main agent because a tab title
    // did not stick is a worse tool.
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
          // The vault is passed explicitly rather than inherited: the agent
          // outlives the command that started it, and the active vault can be
          // switched underneath it. Which context this session belongs to is
          // settled once, here.
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
 * The soft path: with no id and a person at the keyboard, select among the
 * incomplete tasks.
 *
 * The list is `yan ls`'s own scan, so there is one owner for "which tasks are
 * there". Without a TTY there is nobody to answer, so this returns the empty
 * string and `enterTask` refuses with the flag to pass — that order matters,
 * because a prompt reached by a hook, a script or an agent is a hang.
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

/**
 * What entering looks like to a person, in one place because `yan task new`
 * ends by entering and must not print a second version of it.
 */
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
