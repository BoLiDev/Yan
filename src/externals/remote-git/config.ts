import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usageError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';
import { REMOTE_GIT_CONFIG } from './errors.js';
import type { HostKind } from './types.js';

/**
 * This file is the ONLY reader of `conf/config.json`'s remote-git section.
 * Subcommands never branch on the host kind.
 */

export interface RemoteGitConfig {
  readonly kind: HostKind;
  readonly host: string;
}

function configPath(): string {
  return join(yanHome(), 'conf', 'config.json');
}

/**
 * The section is `remote_git`, and `forge` is still read as a fallback.
 *
 * Not politeness: `bin/lib-forge.sh` is still live for the length of the
 * migration and reads `.forge.kind` from the same file, so a machine part-way
 * through has one config that both halves must understand. The fallback goes
 * with the shell half, in Phase 9.
 */
function section(parsed: unknown): { data: Record<string, unknown>; name: string } {
  const root = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const current = root.remote_git;
  if (typeof current === 'object' && current !== null) {
    return { data: current as Record<string, unknown>, name: 'remote_git' };
  }
  const legacy = root.forge;
  if (typeof legacy === 'object' && legacy !== null) {
    return { data: legacy as Record<string, unknown>, name: 'forge' };
  }
  return { data: {}, name: 'remote_git' };
}

export function readConfig(): RemoteGitConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw usageError(
      REMOTE_GIT_CONFIG,
      `no configuration at ${path} - copy conf/config.sample.json there and set remote_git.kind`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw usageError(REMOTE_GIT_CONFIG, `cannot read ${path} - it is not valid JSON; run 'yan doctor'`);
  }

  const { data, name } = section(parsed);

  const kind = typeof data.kind === 'string' ? data.kind : '';
  if (kind === '') {
    throw usageError(
      REMOTE_GIT_CONFIG,
      `${name}.kind is not set in ${path} - set it to github or gitlab, then run 'yan doctor'`,
    );
  }
  if (kind !== 'github' && kind !== 'gitlab') {
    throw usageError(
      REMOTE_GIT_CONFIG,
      `${name}.kind is '${kind}', which yan does not support - use github or gitlab`,
    );
  }

  const host = typeof data.host === 'string' ? data.host : '';
  if (kind === 'gitlab' && host === '') {
    throw usageError(
      REMOTE_GIT_CONFIG,
      `${name}.host is required when ${name}.kind is gitlab - set it in ${path} (hostname, no scheme), then run 'yan doctor'`,
    );
  }
  return { kind, host };
}

/** github.com needs no GH_HOST; anything else does. */
export function hostFor(config: RemoteGitConfig): string | undefined {
  if (config.kind === 'github') {
    return config.host === '' || config.host === 'github.com' ? undefined : config.host;
  }
  return config.host;
}
