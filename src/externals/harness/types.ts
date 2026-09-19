/** The vocabulary the harness module speaks. */

/**
 * What yan knows about one running agent, all of it optional: a harness finds
 * its session file from whichever of these it can use, and answers nothing
 * when none of them lead anywhere.
 */
export interface AgentFacts {
  /** The harness, as `cliKind` spells it: `claude`, `codex`, `agy`. */
  readonly kind: string;
  /** The harness's own session id, when Herdr or the dispatch record carried one. */
  readonly sessionId?: string;
  /** The directory the agent was started in. */
  readonly cwd?: string;
  /** When the agent was started, epoch milliseconds. */
  readonly startedAt?: number;
  /** A process the agent is a direct child of: `yan continue` for the main agent. */
  readonly parentPid?: number;
}

/**
 * Where the harnesses keep their files, and how to ask the process table.
 * Tests hand in a fake home and a fake table; `processes` is only called when
 * a harness needs it.
 */
export interface HarnessEnv {
  readonly home: string;
  /** pid → parent pid for every process, or an empty map when that cannot be read. */
  readonly processes: () => ReadonlyMap<number, number>;
}

/** When an agent last wrote to its session, and which file said so. */
export interface Spoke {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly file: string;
}
