import { parentPort, workerData } from 'node:worker_threads';
import { isYanError } from '../../util/error.js';
import { commitVault, levelWith, saveVault } from '../shared/vault-push.js';

/**
 * One save from the page, `saveVault` on a thread of its own: it waits for
 * the vault's lock and runs git to the network and back, all of it blocking,
 * and on serve's own thread that froze every terminal and request meanwhile.
 * With `push` false it only commits, `commitVault`, the lock still waited
 * for off serve's thread. With `level` set it saves nothing, and brings the
 * vault up to that commit before a change is made, `levelWith`. It answers
 * with the warning the page shows, null when it all went through.
 */
const { dir, message, push, level } = workerData as { readonly dir: string; readonly message: string; readonly push: boolean; readonly level?: string };
let warning: string | null = null;
try {
  if (level !== undefined) levelWith(dir, level);
  else if (push) saveVault(dir, message);
  else commitVault(dir, message);
} catch (err) {
  warning = isYanError(err) ? err.message : String(err);
}
parentPort?.postMessage({ warning });
