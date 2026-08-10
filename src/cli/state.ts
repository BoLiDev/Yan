import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { dash } from './shared/table.js';
import { Terminal, type Alive } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { Shift } from '../records/shift/index.js';
import { currentBranch, isClean } from '../util/git.js';
import { existsSync } from 'node:fs';

/**
 * `yan state <sid>` — what is true about a shift RIGHT NOW.
 *
 * ---------------------------------------------------------------------------
 * THIS COMMAND DOES NOT READ THE LAST LINE OF run/status. NOT EVER.
 * ---------------------------------------------------------------------------
 *
 * agents.md §5.4: *every line in run/status is an event, not the current
 * state.* A shift that reported `done` and then died has `done` as its last
 * line; so has a shift that reported `done` an hour ago and is still waiting
 * for its merge request to be reviewed; so has a shift whose work has since
 * landed. The last line is the most recent thing that HAPPENED, and reading it
 * as the state is the single mistake this command exists to prevent. The record
 * offers no way to do it: `Shift` has `eventCount()` and no `last()`.
 *
 * The state is DERIVED, every time, from the live sources: `run/meta.json` plus
 * the terminal, git and the host.
 *
 * The five verdicts, and the order they are decided in:
 *
 *   clocked-out  run/ is gone. Clocking out deletes it whole, so its absence is
 *                the fact - checked first, because every other source is about
 *                a shift that is still running.
 *   merged       the host says the shift branch's merge request is merged. That
 *                is a shift's objective end condition (§5.3) and it outranks the
 *                terminal on purpose: an agent still sitting in its pane after
 *                the work landed is a shift to clock out, not one to wait for.
 *                Ancestry is never used for this - a squash merge is not an
 *                ancestor of what it landed on.
 *   dead         the terminal says the agent is gone.
 *   running      the terminal says the agent is alive.
 *   unknown      nothing above could be established. Said out loud rather than
 *                rounded up to something more comfortable.
 *
 * `unknown` IS NOT `dead`, and this command must not round it that way
 * (orchestration.md §6). `unknown` means yan could not find out, and clocking a
 * shift out on "could not find out" is how work gets deleted. The two-call
 * derivation that separates them lives in the seam; nothing here re-implements
 * it.
 *
 * `run/meta.json` is read defensively: a missing key costs one fact, never a
 * crash.
 */

export type Verdict = 'clocked-out' | 'merged' | 'dead' | 'running' | 'unknown';

/** What `yan state` needs from the terminal. `Terminal` is the real one. */
export interface AliveReader {
  agentAlive(pane: string): Alive;
}

/** What `yan state` needs from the host. `RemoteGit` is the real one. */
export type MrStateReader = (mr: string, dir: string | undefined) => MrState;

export interface StateFacts {
  readonly version: 1;
  readonly sid: string;
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  readonly tree: string;
  readonly agent: string;
  readonly agent_id: string;
  readonly live: boolean;
  readonly terminal: Alive;
  readonly terminal_why: string;
  readonly tree_state: 'unrecorded' | 'missing' | 'clean' | 'dirty' | 'unknown';
  readonly head_branch: string;
  readonly mr: string;
  readonly mr_state: MrState | 'none';
  readonly events: number;
  readonly state: Verdict;
}

export interface StateDeps {
  readonly terminal?: AliveReader;
  readonly readMrState?: MrStateReader;
}

/** Everything this command establishes, without the process around it. */
export function stateOf(sid: string, task: string, deps: StateDeps = {}): StateFacts {
  const shift = Shift.resolve(sid, task);
  const meta = shift.meta();
  const live = shift.isLive();

  const unit = meta.unit ?? '';
  const branch = meta.branch ?? '';
  const tree = meta.tree ?? '';
  const agent = meta.agent ?? '';
  const agentId = meta.agentId ?? '';
  const mr = meta.mr ?? '';

  // Source 1: the terminal.
  let terminal: Alive = 'unknown';
  let terminalWhy = '';
  if (!live) {
    terminalWhy = 'run/ is gone; there is nothing left to ask about';
  } else if (agentId === '') {
    terminalWhy = 'no terminal id in run/meta.json';
  } else {
    terminal = (deps.terminal ?? new Terminal()).agentAlive(agentId);
  }

  // Source 2: git.
  let treeState: StateFacts['tree_state'] = 'unknown';
  let headBranch = '';
  if (tree === '') {
    treeState = 'unrecorded';
  } else if (!existsSync(tree)) {
    treeState = 'missing';
  } else {
    try {
      headBranch = currentBranch(tree);
      treeState = isClean(tree) ? 'clean' : 'dirty';
    } catch {
      headBranch = '';
      treeState = 'unknown';
    }
  }

  // Source 3: the host. Only when a merge request has been recorded. There is
  // no branch-to-MR lookup here: `mrState` takes the URL `createMr` returned,
  // and inventing a search would put host vocabulary in a subcommand.
  let mrState: MrState | 'none' = 'none';
  if (mr !== '') {
    const dir = tree !== '' && existsSync(tree) ? tree : undefined;
    const ask = deps.readMrState ?? ((url: string, d: string | undefined) => new RemoteGit().mrState({ mr: url, dir: d }));
    mrState = ask(mr, dir);
  }

  let state: Verdict;
  if (!live) state = 'clocked-out';
  else if (mrState === 'merged') state = 'merged';
  else if (terminal === 'dead') state = 'dead';
  else if (terminal === 'alive') state = 'running';
  else state = 'unknown';

  return {
    version: 1,
    sid: shift.sid,
    task: shift.task,
    unit,
    branch,
    tree,
    agent,
    agent_id: agentId,
    live,
    terminal,
    terminal_why: terminalWhy,
    tree_state: treeState,
    head_branch: headBranch,
    mr,
    mr_state: mrState,
    events: shift.eventCount(),
    state,
  };
}

function row(label: string, value: string): void {
  out(`${label.padEnd(10)} ${value}`);
}

export const command = new Command('state')
  .description('what is true about a shift right now')
  .argument('[sid]')
  .option('--task <id>', 'the task the shift belongs to')
  .option('--json', 'every fact this derived, machine readable')
  .option('--verdict', 'print only the derived state word')
  .addHelpText(
    'after',
    `
usage: yan state <sid> [--task <id>] [--json | --verdict]

Verdicts: clocked-out | merged | dead | running | unknown

The state is derived from the live sources every time. Lines in run/status are
EVENTS; this command counts them and never reads the last one as the state.`,
  )
  .action(
    action('state', (sid: string | undefined, options: { task?: string; json?: boolean; verdict?: boolean }) => {
      if (sid === undefined || sid === '') {
        throw CommandError.usage('state', 'a shift id is required');
      }
      if (options.json === true && options.verdict === true) {
        throw CommandError.usage('state', '--json and --verdict are alternatives - pass one');
      }

      const facts = stateOf(sid, options.task ?? '');

      if (options.verdict === true) {
        out(facts.state);
        return;
      }
      if (options.json === true) {
        const { terminal_why: _why, ...rest } = facts;
        out(JSON.stringify(rest));
        return;
      }

      out(facts.sid);
      row('task', dash(facts.task));
      row('unit', dash(facts.unit));
      row('branch', dash(facts.branch));
      row('tree', dash(facts.tree));
      row('agent', dash(facts.agent));
      out('');
      row('terminal', facts.terminal_why !== ''
        ? `${facts.terminal}  (${facts.terminal_why})`
        : `${facts.terminal}  (id ${facts.agent_id})`);
      row('git', facts.head_branch !== '' && facts.branch !== '' && facts.head_branch !== facts.branch
        ? `${facts.tree_state}  (HEAD is on ${facts.head_branch}, meta says ${facts.branch})`
        : facts.tree_state);
      row('forge', facts.mr_state === 'none'
        ? 'none  (no merge request recorded in run/meta.json)'
        : `${facts.mr_state}  (${facts.mr})`);
      row('events', `${facts.events}  (run/status lines are EVENTS, not the state)`);
      out('');
      row('state', facts.state);
    }),
  );
