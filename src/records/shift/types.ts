/**
 * `run/meta.json` — the dispatch record, written by `yan shift new` and read
 * by everything that has to know where a shift is. The fields are named after
 * the file's own keys, so a reader and the writer cannot drift apart.
 *
 * Every field is optional: the shift writes the file while yan reads it, so
 * any of them can be absent, and an empty string is read as absent. The one
 * exception is `scenario`, which `readMeta` defaults — a record from before
 * scenarios existed was a coding shift, and every reader would otherwise say
 * so for itself.
 */
export interface ShiftMeta {
  readonly version?: number;
  readonly task?: string;
  readonly sid?: string;
  readonly unit?: string;
  readonly repo?: string;
  /** The shift branch. */
  readonly branch?: string;
  /** The integration branch it was cut from. */
  readonly base?: string;
  readonly tree?: string;
  /** The main clone the leased tree came from. */
  readonly clone?: string;
  /** Where the agent was started, which is the tree or a scope path inside it. */
  readonly workdir?: string;
  /** The pool holder string, `<task>/<unit>/<sid>`. */
  readonly holder?: string;
  /** The lease `tree get` granted; a conditional return compares it. */
  readonly lease_id?: string;
  readonly agent?: string;
  /** What the shift delivers: `coding`, `explore` or `uix`. */
  readonly scenario: string;
  readonly tier?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly skills?: readonly string[];
  /** The terminal container the pane lives in. Display only. */
  readonly container?: string;
  /** The terminal id the seam printed — a pane id, never a renameable label. */
  readonly pane?: string;
  readonly mr?: string;
  /** What the agent's status was when it started. */
  readonly status?: string;
  /** The agent CLI's own session id, when its integration reported one. */
  readonly agent_session?: string;
  /** When the dispatch happened, ISO to the second. */
  readonly at?: string;
}

/** What `yan shift new` claims the shift directory with, before it knows the rest. */
export type ShiftMetaPlaceholder = Partial<ShiftMeta>;
