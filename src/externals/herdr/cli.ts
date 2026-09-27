import { NOT_STARTED, runProcess, type ProcessResult } from '../../util/process.js';
import { YanError } from '../../util/error.js';

/**
 * The `herdr` executable, and the only module in yan that names it. Needs no
 * environment: herdr finds its own socket.
 *
 *   {"error":{"code":"agent_not_found","message":"…"},"id":"cli:agent:get"}
 *
 *   exit 0   success, possibly with no stdout at all
 *   exit 1   server error, with that JSON on stderr
 *   exit 2   the command shape was wrong: a bug in yan
 *
 * No Herdr `error.code` escapes this file; `mapError` turns each into yan's
 * own vocabulary.
 */

/** The `error.code` Herdr reported, when it reported one. */
export function herdrErrorCode(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const error = (parsed as { error?: { code?: unknown } }).error;
      if (error !== undefined && typeof error.code === 'string') return error.code;
    } catch {
      // Not JSON: herdr may print prose on the same stream.
    }
  }
  return undefined;
}

/**
 * Run a herdr command. Never throws: a failure is a non-zero `code`, and a
 * herdr that will not start is 127.
 */
export function runHerdr(args: readonly string[]): ProcessResult {
  const r = runProcess('herdr', args);
  return r.code === NOT_STARTED ? { ...r, stderr: `herdr is not on PATH: ${r.stderr}` } : r;
}

/** How a herdr command is run; replaceable in a test. */
export type HerdrRunner = (args: readonly string[]) => ProcessResult;

/**
 * The `.result` of a successful herdr command's stdout, or `undefined` when
 * the body is empty, does not parse, or has no `.result`.
 *
 * Only `.result`, never the body in its place: `herdr api schema --json`
 * (protocol 22) makes `{ id, result }` the shape of every success response,
 * and falling back to the whole body would read the envelope as the answer.
 */
export function resultOf(stdout: string): unknown {
  const body = stdout.trim();
  if (body === '') return undefined;
  try {
    return (JSON.parse(body) as { result?: unknown } | null)?.result;
  } catch {
    return undefined;
  }
}

/**
 * Run a herdr command and return its `.result`, or `undefined` when it
 * succeeded without one.
 *
 * @throws YanError when the command failed.
 */
export function herdrCall(run: HerdrRunner, args: readonly string[], what: string): unknown {
  const result = run(args);
  if (result.code === 0) return resultOf(result.stdout);
  throw mapError(result, what);
}

/**
 * Map a Herdr failure onto yan's vocabulary: `bug` for a refused command
 * shape, `notFound` for a missing agent, pane, workspace or tab, `busy` for a
 * pane not yet at its shell prompt, `unreachable` when herdr said nothing
 * structured, `refused` otherwise.
 */
export function mapError(result: ProcessResult, what: string): YanError {
  if (result.code === 2) {
    return YanError.usage('term_bug', `herdr refused the command shape (${what}): ${result.stderr.trim()}`);
  }
  if (result.code === 127) {
    return new YanError('term_unreachable', `cannot reach herdr (${what}): ${result.stderr.trim()}`);
  }

  const code = herdrErrorCode(result.stderr);
  switch (code) {
    case 'agent_not_found':
    case 'pane_not_found':
    case 'workspace_not_found':
    case 'tab_not_found':
      return new YanError('term_not_found', `${what}: ${code}`);
    // `agent_pane_busy` is what `agent start` answers; the bare spelling is
    // kept for a herdr that names it without the prefix.
    case 'agent_pane_busy':
    case 'pane_busy':
      return new YanError('term_busy', `${what}: ${code}`);
    case undefined:
      return new YanError('term_unreachable', `cannot reach herdr (${what}): ${result.stderr.trim()}`);
    default:
      return new YanError('term_refused', `${what}: ${code}`);
  }
}
