/**
 * `run/meta.json`, read as one typed value.
 *
 * Every field is optional, and that is invariant 3 expressed in the type: a
 * missing file, a missing key, a half-written file or a key this phase has
 * never heard of must never crash a reader. "I do not know" is a legal answer
 * for all of them.
 */
export interface ShiftMeta {
  readonly unit?: string;
  readonly branch?: string;
  readonly tree?: string;
  readonly agent?: string;
  /**
   * The terminal id the seam printed. A pane id is preferred over a window id
   * because it is the more precise of the two. NEVER a label: a label is not a
   * source of truth (agents.md §5.7 practice 1, terminal.md §3).
   */
  readonly agentId?: string;
  readonly mr?: string;
  /** The agent CLI's own session id, when its integration reported one. */
  readonly agentSession?: string;
  /** The main clone the leased tree came from, so the pool can be asked about it. */
  readonly clone?: string;
  /** The lease `tree get` granted. Conditional return compares it. */
  readonly leaseId?: string;
  /** The terminal container the pane lives in. Display only; never looked up by. */
  readonly container?: string;
}
