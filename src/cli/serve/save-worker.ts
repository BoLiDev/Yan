import { parentPort, workerData } from 'node:worker_threads';
import { isYanError } from '../../util/error.js';
import { saveVault } from '../shared/vault-push.js';

/**
 * One save from the page, `saveVault` on a thread of its own: it waits for
 * the vault's lock and runs git to the network and back, all of it blocking,
 * and on serve's own thread that froze every terminal and request meanwhile.
 * It answers with the warning the page shows, null when it all went through.
 */
const { dir, message } = workerData as { readonly dir: string; readonly message: string };
let warning: string | null = null;
try {
  saveVault(dir, message);
} catch (err) {
  warning = isYanError(err) ? err.message : String(err);
}
parentPort?.postMessage({ warning });
