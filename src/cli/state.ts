import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { dash } from './shared/table.js';
import { Terminal, type Alive } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { Shift, readPulse } from '../records/shift/index.js';
import { currentBranch, isClean } from '../util/git.js';
import { existsSync } from 'node:fs';

/**
 * `yan state <sid>` — what is true about a shift right now, derived on every
 * call from `run/meta.json`, the terminal, git and the host. Nothing here
 * reads the event log, whose last line is the newest event and not the state.
 *
 * The verdict, decided in this order:
 *
 *   clocked-out  run/ is gone
 *   merged       the host says the merge request merged. Never git ancestry,
 *                and it outranks a pane the agent is still sitting in
 *   dead         the terminal says the agent is gone
 *   running      the terminal says the agent is alive
 *   unknown      nothing above could be established — which is not `dead`
 */

export type Verdict = 'clocked-out' | 'merged' | 'dead' | 'running' | 'unknown';

/**
 * Whether the shift's terminal is moving.
 *
 *   moving     the digest changed recently
 *   still      it has not changed, and the reading is fresh
 *   unsampled  no watcher has taken a reading lately, so this says nothing
 *              about the shift at all
 *
 * `still` is a duration, not a verdict: an install and a model thinking are
 * both still.
 */
export type Motion = 'moving' | 'still' | 'unsampled';

/** How stale a pulse reading may be before it stops being about the shift. */
const PULSE_FRESH_SECONDS = 30;

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
  readonly motion: Motion;
  /** Seconds the terminal has been unchanged. Absent unless `motion` is moving or still. */
  readonly still_for?: number;
  /** Seconds since a watcher last took a reading. Absent when none ever has. */
  readonly sampled_ago?: number;
  readonly state: Verdict;
}

export interface StateDeps {
  readonly terminal?: AliveReader;
  readonly readMrState?: MrStateReader;
}

/**
 * Everything this command establishes. A source that cannot answer costs one
 * fact rather than throwing.
 *
 * @throws ShiftError when `sid` names no shift, or more than one.
 */
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

  // Source 3: the host, only when a merge request URL has been recorded —
  // nothing here searches for one by branch.
  let mrState: MrState | 'none' = 'none';
  if (mr !== '') {
    const dir = tree !== '' && existsSync(tree) ? tree : undefined;
    const ask = deps.readMrState ?? ((url: string, d: string | undefined) => new RemoteGit().mrState({ mr: url, dir: d }));
    mrState = ask(mr, dir);
  }

  // Source 4: the pulse, read and never taken — sampling here would make the
  // answer depend on how often this was called.
  let motion: Motion = 'unsampled';
  let stillFor: number | undefined;
  let sampledAgo: number | undefined;
  if (live) {
    const pulse = readPulse(shift.run);
    if (pulse !== undefined) {
      const now = Math.floor(Date.now() / 1000);
      sampledAgo = Math.max(0, now - pulse.seen);
      if (sampledAgo <= PULSE_FRESH_SECONDS) {
        stillFor = Math.max(0, pulse.seen - pulse.changed);
        motion = stillFor <= PULSE_FRESH_SECONDS ? 'moving' : 'still';
      }
    }
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
    motion,
    ...(stillFor === undefined ? {} : { still_for: stillFor }),
    ...(sampledAgo === undefined ? {} : { sampled_ago: sampledAgo }),
    state,
  };
}

/**
 * The pulse, in words, including the case where there is nothing to say.
 *
 * "still" carries its duration because the duration is the whole signal: three
 * minutes into an install is ordinary and twenty minutes into anything is a
 * reason to look. This line never draws that conclusion.
 */
function motionLine(facts: StateFacts): string {
  if (facts.motion === 'unsampled') {
    return facts.sampled_ago === undefined
      ? 'unsampled  (no watcher has read this terminal - is `yan wait` running?)'
      : `unsampled  (last read ${duration(facts.sampled_ago)} ago, so this says nothing about the shift)`;
  }
  const been = duration(facts.still_for ?? 0);
  return facts.motion === 'moving'
    ? `moving  (changed ${been} ago)`
    : `still  (${been}, which is not the same as stuck - what it was asked to do decides that)`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m < 60 ? `${m}m${s.toString().padStart(2, '0')}s` : `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}m`;
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
events; this command counts them and never reads the last one as the state.

The pulse says whether the shift's terminal is moving, which is what tells a
long silence from a stuck one. It is sampled by 'yan wait' and only read here,
so the answer is about the shift rather than about how often you asked - and
with no watcher running it says so instead of guessing. 'still' is a duration,
never a verdict: an install is still for minutes and so is a model thinking.`,
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
      row('events', `${facts.events}  (run/status lines are events, not the state)`);
  row('pulse', motionLine(facts));
      out('');
      row('state', facts.state);
    }),
  );
