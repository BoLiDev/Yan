import { NOT_STARTED, runProcess, type ProcessResult } from '../../util/process.js';

/**
 * The one place a host CLI is executed. stdout and stderr come back separately
 * and CR-stripped, so a mapper never meets a deprecation notice mixed into its
 * JSON. Authentication is the CLI's own; naming a host only picks which of its
 * stored logins to use.
 */

export interface CliInvocation {
  readonly cli: 'gh' | 'glab';
  readonly args: readonly string[];
  /** Run in this directory, when the caller named one with `dir`. */
  readonly cwd?: string;
  /** GH_HOST / GITLAB_HOST, when the configured host names one. */
  readonly host?: string;
}

/** Never throws: a CLI that will not start comes back as `NOT_STARTED`. */
export function runCli(invocation: CliInvocation): ProcessResult {
  const env = { ...process.env };
  if (invocation.host !== undefined && invocation.host !== '') {
    if (invocation.cli === 'gh') env.GH_HOST = invocation.host;
    else env.GITLAB_HOST = invocation.host;
  }

  const r = runProcess(invocation.cli, invocation.args, { cwd: invocation.cwd, env });
  if (r.code === NOT_STARTED) {
    return { ...r, stderr: `remote-git: ${invocation.cli} is not on PATH - install it, then run 'yan doctor'` };
  }
  return { code: r.code, stdout: r.stdout.replace(/\r/g, ''), stderr: r.stderr.replace(/\r/g, '') };
}
