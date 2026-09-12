import { readJsonIfPresent } from './json.js';
import { asRecord } from './narrow.js';
import { vaultConfigPath } from './vault.js';

/**
 * The vault's `config.json`, opened and parsed in one place. Two modules own a
 * section each and may not import one another — `remote_git` inside
 * `externals/remote-git`, `agents` and `scenarios` in `cli/shared/config.ts` —
 * so this lives below both. Nothing here judges what is in it.
 *
 * A file that is not there is `undefined`; one that is there and does not
 * parse throws, because a configuration someone wrote and got wrong is not the
 * same as no configuration, and each owner words that refusal its own way.
 *
 * @throws JsonError `invalid` when the file is not JSON.
 */
export function readVaultConfig(): Record<string, unknown> | undefined {
  const raw = readJsonIfPresent(vaultConfigPath());
  return raw === undefined ? undefined : asRecord(raw);
}
