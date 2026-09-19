import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentSpecFor, cliKind } from '../shared/config.js';
import { enterLockFile } from '../shared/enter-lock.js';
import { Terminal } from '../../externals/herdr/index.js';
import { harnessEnv, lastSpoke, type AgentFacts, type HarnessEnv } from '../../externals/harness/index.js';
import { readPulse, Shift } from '../../records/shift/index.js';
import { isStale, owner } from '../../util/lock.js';
import { later, secondMoment, type Moment } from './when.js';

/**
 * When a task's agents last said something: the newest over the main agent
 * and every live shift, each read off a ladder that falls rung by rung —
 *
 *   1. the harness's own session file (`session`)
 *   2. the shift's pulse, when it has been sampled (`pulse`)
 *   3. the last line of the shift's run/status (`status`)
 *
 * and, when no agent gave anything, the task's last log entry, to the day.
 */

/** What Herdr says about one pane's agent. */
export interface HerdrAgent {
  readonly kind: string;
  readonly session?: string;
}

export interface ActiveDeps {
  readonly harness: HarnessEnv;
  /** pane → agent, asked at most once; an empty map when Herdr is not there. */
  readonly herdr: () => ReadonlyMap<string, HerdrAgent>;
  /** The harness the main agent runs, as `cliKind` spells it. */
  readonly mainKind: () => string;
}

/** The real Herdr, harness files and config, each read at most once across every task. */
export function activeDeps(): ActiveDeps {
  let agents: ReadonlyMap<string, HerdrAgent> | undefined;
  let main: string | undefined;
  return {
    harness: harnessEnv(),
    herdr: () => {
      if (agents !== undefined) return agents;
      const found = new Map<string, HerdrAgent>();
      try {
        for (const a of new Terminal().list()) {
          found.set(a.pane, { kind: a.kind, ...(a.agent_session === undefined ? {} : { session: a.agent_session }) });
        }
      } catch {
        // No Herdr: yan outside it, or Herdr not running. The ladder carries on.
      }
      agents = found;
      return agents;
    },
    mainKind: () => {
      if (main !== undefined) return main;
      try {
        main = cliKind(agentSpecFor('yan').cli);
      } catch {
        main = '';
      }
      return main;
    },
  };
}

/** The main agent, when a live `yan continue` holds the task's enter lock. */
function mainFacts(task: string, deps: ActiveDeps): AgentFacts | undefined {
  const file = enterLockFile(task);
  const held = owner(file);
  if (held === undefined || isStale(file)) return undefined;
  const pane = /(?:^| )pane=(\S+)/.exec(held.identity ?? '')?.[1];
  const herdr = pane === undefined ? undefined : deps.herdr().get(pane);
  const kind = deps.mainKind() || herdr?.kind || '';
  return {
    kind,
    ...(herdr?.session === undefined ? {} : { sessionId: herdr.session }),
    startedAt: held.at * 1000,
    parentPid: held.pid,
  };
}

function shiftFacts(shift: Shift, deps: ActiveDeps): AgentFacts {
  const meta = shift.meta();
  let session = meta.agent_session;
  let kind = meta.agent === undefined ? '' : cliKind(meta.agent);
  if (session === undefined && meta.pane !== undefined) {
    const herdr = deps.herdr().get(meta.pane);
    session = herdr?.session;
    if (kind === '') kind = herdr?.kind ?? '';
  }
  const started = meta.at === undefined ? Number.NaN : Date.parse(meta.at);
  const cwd = meta.workdir ?? meta.tree;
  return {
    kind,
    ...(session === undefined ? {} : { sessionId: session }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(Number.isNaN(started) ? {} : { startedAt: started }),
  };
}

/** The time on the last line of run/status. */
function lastStatus(shift: Shift): Moment | undefined {
  let text: string;
  try {
    text = readFileSync(join(shift.run, 'status'), 'utf8');
  } catch {
    return undefined;
  }
  const line = text.split(/\r?\n/).filter((l) => l !== '').pop();
  const ms = Date.parse(line?.split('\t')[0] ?? '');
  return Number.isNaN(ms) ? undefined : secondMoment(ms, 'status');
}

function shiftActive(shift: Shift, deps: ActiveDeps): Moment | undefined {
  try {
    const spoke = lastSpoke(shiftFacts(shift, deps), deps.harness);
    if (spoke !== undefined) return secondMoment(spoke.at, 'session');
  } catch {
    // Next rung.
  }
  try {
    const pulse = readPulse(shift.run);
    if (pulse !== undefined && pulse.seen > 0) return secondMoment(pulse.changed * 1000, 'pulse');
  } catch {
    // Next rung.
  }
  return lastStatus(shift);
}

function mainActive(task: string, deps: ActiveDeps): Moment | undefined {
  try {
    const facts = mainFacts(task, deps);
    if (facts === undefined) return undefined;
    const spoke = lastSpoke(facts, deps.harness);
    return spoke === undefined ? undefined : secondMoment(spoke.at, 'session');
  } catch {
    return undefined;
  }
}

/**
 * When an open task's agents last spoke, or `logLast` when none of them says.
 * Never throws.
 */
export function taskActive(task: string, logLast: Moment | undefined, deps: ActiveDeps): Moment | undefined {
  let newest = mainActive(task, deps);
  let shifts: Shift[] = [];
  try {
    shifts = Shift.liveIn(task);
  } catch {
    shifts = [];
  }
  for (const shift of shifts) newest = later(newest, shiftActive(shift, deps));
  return newest ?? logLast;
}
