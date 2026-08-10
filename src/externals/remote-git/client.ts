import { spawnSync } from 'node:child_process';

/**
 * The one place a host CLI is actually executed.
 *
 * Host routing lives here. It is NOT authentication: `gh` and `glab` each keep
 * their own login, and naming the host only tells the CLI which of its own
 * stored credentials to use. A missing login is `yan doctor`'s business.
 *
 * stderr is captured rather than merged, because merging it would corrupt the
 * JSON on stdout the moment a CLI printed a deprecation notice — and a mapper
 * fed corrupted JSON would answer `unknown` for a perfectly healthy MR.
 *
 * This file is the module's only edge to the outside world, which is what lets
 * a test replace it by import rather than by an environment-variable trick
 * (plan/conventions.md §5).
 */

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliInvocation {
  readonly cli: 'gh' | 'glab';
  readonly args: readonly string[];
  /** Run in this directory, when the caller named one with `dir`. */
  readonly cwd?: string;
  /** GH_HOST / GITLAB_HOST, when the configured host names one. */
  readonly host?: string;
}

/** rc 127 is "the CLI is not installed", which is not an answer at all. */
export const CLI_MISSING = 127;

export function runCli(invocation: CliInvocation): CliResult {
  const env = { ...process.env };
  if (invocation.host !== undefined && invocation.host !== '') {
    if (invocation.cli === 'gh') env.GH_HOST = invocation.host;
    else env.GITLAB_HOST = invocation.host;
  }

  const spawned = spawnSync(invocation.cli, [...invocation.args], {
    cwd: invocation.cwd,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });

  if (spawned.error !== undefined) {
    return {
      code: CLI_MISSING,
      stdout: '',
      stderr: `remote-git: ${invocation.cli} is not on PATH - install it, then run 'yan doctor'`,
    };
  }

  // gh.exe and glab.exe are native Windows programs: their output arrives
  // CRLF-terminated on Git Bash. Strip it here, once, so neither the JSON
  // mappers nor the URL extractor ever has to think about it. (This is the one
  // CR strip that survives V2 — the jq ones went with jq.)
  const clean = (s: string | null): string => (s ?? '').replace(/\r/g, '');
  return {
    code: spawned.status ?? 1,
    stdout: clean(spawned.stdout),
    stderr: clean(spawned.stderr),
  };
}
