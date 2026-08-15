import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The `remote_git` section, or `'legacy'` when the file still spells it
 * `forge` — which is reported so it can be renamed, never read.
 */
function section(parsed: unknown): Record<string, unknown> | 'legacy' | undefined {
  const root = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const current = root.remote_git;
  if (typeof current === 'object' && current !== null) return current as Record<string, unknown>;
  const legacy = root.forge;
  if (typeof legacy === 'object' && legacy !== null) return 'legacy';
  return undefined;
}

/**
 * @throws RemoteGitError `config` (exit 2) when the file is missing, unparseable,
 *   names no supported `kind`, or is a gitlab config with no `host`.
 */
export function readConfig(): RemoteGitConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw RemoteGitError.config(`no configuration at ${path} - copy templates/vault/config.json there and set remote_git.kind`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw RemoteGitError.config(`cannot read ${path} - it is not valid JSON; run 'yan doctor'`);
  }

  const found = section(parsed);
  if (found === 'legacy') {
    throw RemoteGitError.config(`${path} configures the host under \`forge\`, which yan stopped reading in V2 - rename that section to \`remote_git\` (the keys inside it are unchanged), then run 'yan doctor'`,
    );
  }
  const data = found ?? {};

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
