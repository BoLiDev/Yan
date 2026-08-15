import { join } from 'node:path';
import { vaultConfigPath } from '../../util/vault.js';
import { readJsonIfPresent } from '../../util/json.js';

/**
 * The `agents.*` section of the vault's `config.json`. `remote_git` is read
 * inside `externals/remote-git` and nowhere else.
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
