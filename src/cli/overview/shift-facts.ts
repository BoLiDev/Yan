import { lastEvent, readUndelivered, type Shift, type ShiftEvent, type ShiftMeta } from '../../records/shift/index.js';

/**
 * What a shift's own files say about it: `run/meta.json`, the newest line of
 * `run/status` and the queue in `run/undelivered`. One row of `yan show` and
 * of `yan session-start` each, which add what only they ask — show the task's
 * state, session start the terminal, the pool and the forge.
 *
 * Every string is `''` when the file does not say. A shift that has clocked
 * out has no `run/`, so it has no event and nothing undelivered either.
 */
export interface ShiftFacts {
  readonly sid: string;
  readonly unit: string;
  /** The shift branch. */
  readonly branch: string;
  readonly tree: string;
  /** `coding`, `explore` or `uix`. */
  readonly scenario: string;
  readonly tier: string;
  /** The agent CLI the shift runs in. */
  readonly agent: string;
  /** The terminal id the agent runs in. */
  readonly pane: string;
  /** The terminal container the pane lives in. */
  readonly container: string;
  /** The merge request address recorded at dispatch: an address, not whether it merged. */
  readonly mr: string;
  /** Whether `run/` is still there: false once the shift clocked out. */
  readonly live: boolean;
  /** The newest line of `run/status`: an event, not the shift's state. */
  readonly last_event: ShiftEvent | null;
  /** Reports that reached `run/status` and never reached yan, oldest first. */
  readonly undelivered: readonly ShiftEvent[];
}

/** One shift, from its files. `meta` is for a caller that has already read it. */
export function shiftFacts(shift: Shift, meta: ShiftMeta = shift.meta()): ShiftFacts {
  return {
    sid: shift.sid,
    unit: meta.unit ?? '',
    branch: meta.branch ?? '',
    tree: meta.tree ?? '',
    scenario: meta.scenario,
    tier: meta.tier ?? '',
    agent: meta.agent ?? '',
    pane: meta.pane ?? '',
    container: meta.container ?? '',
    mr: meta.mr ?? '',
    live: shift.isLive(),
    last_event: lastEvent(shift.run) ?? null,
    undelivered: readUndelivered(shift.run),
  };
}
