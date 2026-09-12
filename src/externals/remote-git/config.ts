import { existsSync, readFileSync } from 'node:fs';
import { vaultConfigPath } from '../../util/vault.js';
import { RemoteGitError } from './errors.js';
import type { HostKind } from './types.js';

/** The vault config's `remote_git` section. */

export interface RemoteGitConfig {
  readonly kind: HostKind;
  readonly host: string;
}

function configPath(): string {
  return vaultConfigPath();
}

/** The `remote_git` section, when the file has one. */
function section(parsed: unknown): Record<string, unknown> | undefined {
  const root = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const current = root.remote_git;
  if (typeof current === 'object' && current !== null) return current as Record<string, unknown>;
  return undefined;
}

/**
 * @throws RemoteGitError `config` (exit 2) when the file is missing, unparseable,
 *   names no supported `kind`, or is a gitlab config with no `host`.
 */
export function readConfig(): RemoteGitConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw RemoteGitError.config(`no configuration at ${path} - copy templates/vault/config.example.json there and set remote_git.kind`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw RemoteGitError.config(`cannot read ${path} - it is not valid JSON; run 'yan doctor'`);
  }

  const data = section(parsed) ?? {};

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
