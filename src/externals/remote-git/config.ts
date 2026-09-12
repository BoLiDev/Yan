import { readVaultConfig } from '../../util/config.js';
import { asRecord } from '../../util/narrow.js';
import { vaultConfigPath } from '../../util/vault.js';
import { RemoteGitError } from './errors.js';
import type { HostKind } from './types.js';

/** The vault config's `remote_git` section. */

export interface RemoteGitConfig {
  readonly kind: HostKind;
  readonly host: string;
}

/**
 * @throws RemoteGitError `config` (exit 2) when the file is missing, unparseable,
 *   names no supported `kind`, or is a gitlab config with no `host`.
 */
export function readConfig(): RemoteGitConfig {
  const path = vaultConfigPath();
  let root: Record<string, unknown> | undefined;
  try {
    root = readVaultConfig();
  } catch {
    throw RemoteGitError.config(`cannot read ${path} - it is not valid JSON; run 'yan doctor'`);
  }
  if (root === undefined) {
    throw RemoteGitError.config(`no configuration at ${path} - copy templates/vault/config.example.json there and set remote_git.kind`,
    );
  }

  const data = asRecord(root.remote_git);

  const kind = typeof data.kind === 'string' ? data.kind : '';
  if (kind === '') {
    throw RemoteGitError.config(`remote_git.kind is not set in ${path} - set it to github or gitlab, then run 'yan doctor'`,
    );
  }
  if (kind !== 'github' && kind !== 'gitlab') {
    throw RemoteGitError.config(`remote_git.kind is '${kind}', which yan does not support - use github or gitlab`,
    );
  }

  const host = typeof data.host === 'string' ? data.host : '';
  if (kind === 'gitlab' && host === '') {
    throw RemoteGitError.config(`remote_git.host is required when remote_git.kind is gitlab - set it in ${path} (hostname, no scheme), then run 'yan doctor'`,
    );
  }
  return { kind, host };
}

/** The host to put in the CLI's environment, or undefined for github.com. */
export function hostFor(config: RemoteGitConfig): string | undefined {
  if (config.kind === 'github') {
    return config.host === '' || config.host === 'github.com' ? undefined : config.host;
  }
  return config.host;
}
