import { spawnSync } from 'node:child_process';
import { TerminalError } from './errors.js';

/**
 * The `herdr` executable, and the only module in yan that names it.
 *
 * It needs no environment. With `HERDR_ENV`, `HERDR_SOCKET_PATH` and
 * `HERDR_PANE_ID` all stripped, `herdr pane list` still answers — it finds the
 * default socket itself. That is what makes yan safe to call from a hook, which
 * may be handed a sanitised environment, and it is worth re-checking whenever
 * Herdr is upgraded.
 *
 * The wire contract:
 *
 *   {"error":{"code":"agent_not_found","message":"…"},"id":"cli:agent:get"}
 *
 *   exit 0   success. Some mutating commands succeed with no stdout at all, so
 *            an empty body is not a failure
 *   exit 1   server error, with that JSON on stderr — parse error.code
 *   exit 2   the command shape was wrong: a bug in yan, never a condition
 *
 * No Herdr `error.code` escapes this file. Mapping them into yan's own
 * vocabulary here is what keeps every caller from having to know two
 * spellings of the same failure.
 */


export interface HerdrResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The `error.code` Herdr reported, when it reported one. */
export function herdrErrorCode(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const error = (parsed as { error?: { code?: unknown } }).error;
      if (error !== undefined && typeof error.code === 'string') return error.code;
    } catch {
      // Prose, not JSON. Herdr is a preview build and may print either.
    }
  }
  return undefined;
}

/**
 * Run a herdr command. Never throws for a Herdr-level failure: the caller
 * decides what one means, because `agent_not_found` is a problem to one caller
 * and the answer itself to another — it is how `agentAlive` tells a dead agent
 * from a live one.
 */
export function runHerdr(args: readonly string[]): HerdrResult {
  const spawned = spawnSync('herdr', [...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (spawned.error !== undefined) {
    // Not installed, or not startable. That is "yan could not find out".
    return { code: 127, stdout: '', stderr: `herdr is not on PATH: ${spawned.error.message}` };
  }
  return {
    code: spawned.status ?? 1,
    stdout: spawned.stdout ?? '',
    stderr: spawned.stderr ?? '',
  };
}

/** How a herdr command is actually run. Replaceable so a test needs no module mocking. */
export type HerdrRunner = (args: readonly string[]) => HerdrResult;

/**
 * Run a herdr command that must succeed, and return its parsed `.result`.
 *
 * Mutating commands legitimately answer with rc 0 and empty stdout, so an empty
 * body is `undefined`, never an error.
 */
export function herdrCall(run: HerdrRunner, args: readonly string[], what: string): unknown {
  const result = run(args);
  if (result.code === 0) {
    const body = result.stdout.trim();
    if (body === '') return undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      return (parsed as { result?: unknown }).result ?? parsed;
    } catch {
      return undefined;
    }
  }
  throw mapError(result, what);
}

/** Map a Herdr failure onto yan's vocabulary. Nothing else may do this. */
export function mapError(result: HerdrResult, what: string): TerminalError {
  if (result.code === 2) {
    // A CLI syntax error is a bug in yan, never a runtime condition.
    return TerminalError.bug(`herdr refused the command shape (${what}): ${result.stderr.trim()}`);
  }
  if (result.code === 127) {
    return new TerminalError('unreachable', `cannot reach herdr (${what}): ${result.stderr.trim()}`);
  }

  const code = herdrErrorCode(result.stderr);
  switch (code) {
    case 'agent_not_found':
    case 'pane_not_found':
    case 'workspace_not_found':
    case 'tab_not_found':
      return new TerminalError('notFound', `${what}: ${code}`);
    case undefined:
      // rc 1 with no structured error is a transport problem, not a verdict.
      return new TerminalError('unreachable', `cannot reach herdr (${what}): ${result.stderr.trim()}`);
    default:
      return new TerminalError('refused', `${what}: ${code}`);
  }
}
