/**
 * `run/meta.json`, read as one typed value.
 *
 * Every field is optional, which is deliberate rather than lax. This file is
 * written by the shift while yan is reading it, so a missing file, a missing
 * key or a half-written one must cost a caller one fact and never a crash.
 * "I do not know" is a legal answer for all of them.
 */
export interface ShiftMeta {
  readonly unit?: string;
  readonly branch?: string;
  readonly tree?: string;
  readonly agent?: string;
  /**
   * The terminal id the seam printed — a pane id for preference, being the more
   * precise of the two. never a label: a label can be renamed, and is cleared
   * outright when an agent exits, which is when yan most needs to identify it.
   */
  readonly agentId?: string;
  readonly mr?: string;
  /** The agent CLI's own session id, when its integration reported one. */
  readonly agentSession?: string;
  /** The main clone the leased tree came from, so the pool can be asked about it. */
  readonly clone?: string;
  /** The lease `tree get` granted. Conditional return compares it. */
  readonly leaseId?: string;
  /** The pool holder string, `<task>/<unit>/<sid>`. Conditional return compares it too. */
  readonly holder?: string;
  /** The terminal container the pane lives in. Display only; never looked up by. */
  readonly container?: string;
}
