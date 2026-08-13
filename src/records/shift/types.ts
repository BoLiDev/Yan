/**
 * `run/meta.json`, read as one typed value. Every field is optional: the file
 * is written by the shift while yan reads it, so any of them can be absent.
 */
export interface ShiftMeta {
  readonly unit?: string;
  readonly branch?: string;
  readonly tree?: string;
  readonly agent?: string;
  /** The terminal id the seam printed — a pane id, never a renameable label. */
  readonly agentId?: string;
  readonly mr?: string;
  /** The agent CLI's own session id, when its integration reported one. */
  readonly agentSession?: string;
  /** The main clone the leased tree came from. */
  readonly clone?: string;
  /** The lease `tree get` granted; a conditional return compares it. */
  readonly leaseId?: string;
  /** The pool holder string, `<task>/<unit>/<sid>`. */
  readonly holder?: string;
  /** The terminal container the pane lives in. Display only. */
  readonly container?: string;
}
