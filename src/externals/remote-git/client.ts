import { spawnSync } from 'node:child_process';

/**
 * The one place a host CLI is executed. stdout and stderr come back separately
 * and CR-stripped, so a mapper never meets a deprecation notice mixed into its
 * JSON. Authentication is the CLI's own; naming a host only picks which of its
 * stored logins to use.
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

/** The code reported when the CLI is not on PATH. */
export const CLI_MISSING = 127;

/** Never throws: a CLI that will not start comes back as `CLI_MISSING`. */
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

  const clean = (s: string | null): string => (s ?? '').replace(/\r/g, '');
  return {
    code: spawned.status ?? 1,
    stdout: clean(spawned.stdout),
    stderr: clean(spawned.stderr),
  };
}
