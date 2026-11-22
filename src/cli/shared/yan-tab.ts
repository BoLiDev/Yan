import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_SINCE, atLeast, createTab, herdrWorkspace, readPane, sendText, serverOf } from '../../externals/herdr/index.js';
import { YanError, isYanError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';
import { terminalsOf } from '../../util/machine.js';

/**
 * A herdr tab opened for bare `yan`, which is typed into it as `user` would
 * type it there, with the answers it would otherwise ask for. What bare
 * `yan` says as it makes a task and its trees, and the agent after, is that
 * tab's: `yan serve` opens one for a task started or gone on with from its
 * page, and for Janus as it starts; `yan handoff` opens one for the task it
 * makes.
 */

/** A word for the shell as sh, bash, zsh and fish all read it back as it was: as it is when nothing in it is the shell's, else in single quotes. */
const quoted = (word: string): string => (/^[\w./:@%+=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/**
 * Until the new tab's shell has drawn something and gone still: the shell
 * draws its prompt as it starts reading the terminal, and what is typed
 * before it does, the terminal echoes, then the shell draws again, so the
 * command would show twice. Typed anyway after a few seconds.
 */
async function shellReady(socket: string, pane: string, still = 300, most = 5000): Promise<void> {
  const end = Date.now() + most;
  let seen = -1;
  let since = Date.now();
  while (Date.now() < end) {
    const now = await readPane(socket, pane).catch(() => undefined);
    if (now !== undefined && now.text.trim() !== '') {
      if (now.revision !== seen) [seen, since] = [now.revision, Date.now()];
      else if (Date.now() - since >= still) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The herdr a tab is opened in: the one this process runs in, else the one
 * an agent of `vault` was started in, else whichever `herdr` on the PATH finds.
 */
export function herdrBin(vault: string): string {
  return process.env.HERDR_BIN_PATH?.trim() || terminalsOf(vault)[0]?.bin || 'herdr';
}

/**
 * A herdr tab named `title`, bare `yan` typed into it with `args`, in
 * `vault`: the shell starts where bare `yan` typed by hand would, at home.
 *
 * @throws YanError `tab_no_herdr` when herdr is not running or too old to be
 *   told what to do, `tab_unreachable` when it cannot be found or spoken to.
 */
export async function openYanTab(bin: string, vault: string, title: string, args: readonly string[]): Promise<{ socket: string; pane: string }> {
  try {
    const herdr = await serverOf(bin);
    if (!herdr.running) throw new YanError('tab_no_herdr', 'herdr is not running: open it in a terminal first');
    if (!atLeast(herdr.version, CONTROL_SINCE)) throw new YanError('tab_no_herdr', `herdr ${herdr.version} is too old: ${CONTROL_SINCE} or newer is needed`);
    const pane = await createTab(herdr.socket, { cwd: homedir(), label: title, env: { YAN_VAULT: vault }, workspace: herdrWorkspace(process.env) });
    const words = [process.execPath, join(yanHome(), 'bin', 'yan.mjs'), ...args];
    await shellReady(herdr.socket, pane);
    await sendText(herdr.socket, pane, `${words.map(quoted).join(' ')}\r`);
    return { socket: herdr.socket, pane };
  } catch (err) {
    if (isYanError(err) && err.code === 'tab_no_herdr') throw err;
    const why = err instanceof Error ? err.message : String(err);
    if (!isYanError(err) || err.code === 'herdr_unreachable') throw new YanError('tab_unreachable', `herdr cannot be found (${bin}): ${why}`);
    throw err;
  }
}
