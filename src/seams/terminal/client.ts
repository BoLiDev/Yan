import { spawnSync } from 'node:child_process';
import { YanError } from '../../util/error.js';

/**
 * Talking to Herdr. The socket/CLI transport and the error mapping, and the
 * only module in yan that names the `herdr` executable.
 *
 * The CLI is the transport. It does not require `HERDR_ENV`,
 * `HERDR_SOCKET_PATH` or `HERDR_PANE_ID` to be set — with all three stripped,
 * `herdr pane list` still answers, finding the default socket itself
 * (evidence.md §1). **That is what makes the hook path safe**, and it must be
 * re-verified whenever Herdr is upgraded.
 *
 * Responses are JSON on stdout. Errors are JSON on STDERR with a stable `code`:
 *
 *   {"error":{"code":"agent_not_found","message":"…"},"id":"cli:agent:get"}
 *
 *   exit 0   success (some mutating commands succeed silently with no stdout
 *            at all — do not treat empty output as failure, evidence.md §4)
 *   exit 1   server error — parse error.code
 *   exit 2   CLI syntax error — a bug in yan, never a runtime condition
 *
 * No Herdr `error.code` escapes this seam: it is mapped into yan's own
 * vocabulary here and nowhere else (architecture.md §4.3 rule 1).
 */

export const TERM_UNREACHABLE = 'term_unreachable';
export const TERM_NOT_FOUND = 'term_not_found';
export const TERM_REFUSED = 'term_refused';
export const TERM_BUG = 'term_bug';

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
 * Run a herdr command. Never throws for a Herdr-level failure — the caller
 * decides what a failure means, because "agent_not_found" is an answer in one
 * place and a problem in another (§5's two-step derivation is the reason).
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

/**
 * Run a herdr command that must succeed, and return its parsed `.result`.
 *
 * Mutating commands legitimately answer with rc 0 and empty stdout, so an empty
 * body is `undefined`, never an error.
 */
export function herdrCall(args: readonly string[], what: string): unknown {
  const result = runHerdr(args);
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
export function mapError(result: HerdrResult, what: string): YanError {
  if (result.code === 2) {
    // A CLI syntax error is a bug in yan, never a runtime condition.
    return new YanError(TERM_BUG, `herdr refused the command shape (${what}): ${result.stderr.trim()}`, {
      exitCode: 2,
    });
  }
  if (result.code === 127) {
    return new YanError(TERM_UNREACHABLE, `cannot reach herdr (${what}): ${result.stderr.trim()}`);
  }

  const code = herdrErrorCode(result.stderr);
  switch (code) {
    case 'agent_not_found':
    case 'pane_not_found':
    case 'workspace_not_found':
    case 'tab_not_found':
      return new YanError(TERM_NOT_FOUND, `${what}: ${code}`);
    case undefined:
      // rc 1 with no structured error is a transport problem, not a verdict.
      return new YanError(TERM_UNREACHABLE, `cannot reach herdr (${what}): ${result.stderr.trim()}`);
    default:
      return new YanError(TERM_REFUSED, `${what}: ${code}`);
  }
}
