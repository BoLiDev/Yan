import { join } from 'node:path';
import { vaultConfigPath } from '../../util/vault.js';
import { readJsonIfPresent } from '../../util/json.js';

/**
 * The bits of `conf/config.json` the command layer reads.
 *
 * `remote_git` is NOT one of them: that section has exactly one reader, inside
 * `externals/remote-git`, so that no subcommand ever branches on the host kind.
 * What is here is `agents.*`, which is a command-layer decision — which CLI to
 * start for a shift — and nothing else.
 */

export function configPath(): string {
  return vaultConfigPath();
}

/** `agents.<role>`, or the empty string when it is not configured. */
export function agentFor(role: string): string {
  const config = readJsonIfPresent(configPath());
  if (typeof config !== 'object' || config === null) return '';
  const agents = (config as Record<string, unknown>).agents;
  if (typeof agents !== 'object' || agents === null) return '';
  const value = (agents as Record<string, unknown>)[role];
  return typeof value === 'string' ? value : '';
}
