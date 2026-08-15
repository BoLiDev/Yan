import { spawnSync } from 'node:child_process';
import { TerminalError } from './errors.js';

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
      // Not JSON: herdr may print prose on the same stream.
    }
  }
  return undefined;
}

/**
 * Run a herdr command. Never throws: a failure is a non-zero `code`, and a
 * herdr that will not start is 127.
 */
export function runHerdr(args: readonly string[]): HerdrResult {
  const spawned = spawnSync('herdr', [...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (spawned.error !== undefined) {
    return { code: 127, stdout: '', stderr: `herdr is not on PATH: ${spawned.error.message}` };
  }
  return {
    code: spawned.status ?? 1,
    stdout: spawned.stdout ?? '',
    stderr: spawned.stderr ?? '',
  };
}

/** How a herdr command is run; replaceable in a test. */
export type HerdrRunner = (args: readonly string[]) => HerdrResult;

/**
 * Run a herdr command and return its parsed `.result`, or `undefined` when it
 * succeeded with an empty or unparseable body.
 *
 * @throws TerminalError when the command failed.
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

/**
 * Map a Herdr failure onto yan's vocabulary: `bug` for a refused command
 * shape, `notFound` for a missing agent, pane, workspace or tab, `unreachable`
 * when herdr said nothing structured, `refused` otherwise.
 */
export function mapError(result: HerdrResult, what: string): TerminalError {
  if (result.code === 2) {
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
      return new TerminalError('unreachable', `cannot reach herdr (${what}): ${result.stderr.trim()}`);
    default:
      return new TerminalError('refused', `${what}: ${code}`);
  }
}
