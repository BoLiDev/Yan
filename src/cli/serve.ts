import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { YanError } from '../util/error.js';
import { remoteUrl } from '../util/git.js';
import { yanHome } from '../util/home.js';
import { readMachine } from '../util/machine.js';
import { readVaultJson, vaultDir } from '../util/vault.js';
import { action, out } from './shared/action.js';
import { openPath } from './shared/opener.js';
import { bold, cyan, dim, green, tildePath } from './shared/style.js';
import { YanServer } from './serve/server.js';

/**
 * `yan serve [--port <n>] [--every <seconds>] [--no-open]` — the vault in a
 * browser, on this machine only: every task, its problem, deliverables, log
 * and branch, and every file its agents wrote, shown as what it is. It runs
 * until stopped, fetching the vault every `--every` seconds, and an open page
 * follows what arrives without being reloaded (`serve/server.ts`).
 *
 * It reads git objects, never the work tree, and fetches into refs of its
 * own, so it never moves anything an agent or a hook works with. The one
 * thing it writes is what `user` does on its page: a deliverable ticked or
 * given up, a report's text edited, committed and pushed at once.
 *
 * Left running while yan is updated, it restarts on the newer build by
 * itself, on the same port, and an open page reloads onto it.
 */

const DEFAULT_PORT = 4747;

function whole(flag: string, value: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw YanError.usage('serve_usage', `${flag} takes a whole number from ${min} to ${max}, not '${value}'`);
  return n;
}

/**
 * This command again, as the build now in yan's clone: in this same process
 * where the platform can replace one, so the terminal, its Ctrl+C and the
 * signals bin/yan.mjs passes on reach it as before; else, on Windows, as a
 * child this one waits on and passes signals to, as bin/yan.mjs does.
 */
function relaunch(): void {
  const args = [join(yanHome(), 'dist', 'cli', 'yan.js'), ...process.argv.slice(2), '--no-open'];
  if (process.platform !== 'win32' && process.execve !== undefined) process.execve(process.execPath, [process.execPath, ...args], process.env);
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  process.on('SIGINT', () => {});
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 1));
}

/**
 * What serve says in its terminal, set off from the shell by blank lines and
 * indented: its name and the vault's, then one line each, under an arrow,
 * for the page's address, the line the terminal is looked at for and so the
 * one in colour, the vault's folder and how it is fetched, and how to stop
 * it. Piped, the same lines go out with no colour.
 */
function head(name: string): string[] {
  return ['', `  ${bold('yan serve')}  ${dim(name)}`, ''];
}

function item(label: string, value: string, strong = false): string {
  return `  ${green('➜')}  ${(strong ? bold : dim)(label)}${' '.repeat(8 - label.length)}${value}`;
}

function started(name: string, address: string, dir: string, everyS: number): string[] {
  const fetches = remoteUrl(dir) === undefined ? 'none, a local vault with no origin' : `origin, every ${everyS} s`;
  return [
    ...head(name),
    item('Page', cyan(address), true),
    item('Vault', dim(tildePath(dir))),
    item('Fetch', dim(fetches)),
    '',
    `  ${dim('Ctrl+C to stop')}`,
  ];
}

/**
 * At a terminal serve takes a screen of its own, as less and top do: the
 * terminal's alternate screen, which keeps no history to scroll back
 * through, so its few lines are all there is to see. Leaving it puts the
 * terminal back as it was before serve started, nothing in it lost, and the
 * line saying serve stopped goes there. It is left on every way out, an
 * error's included, before the error is printed, so the error can be read;
 * a restart onto a newer build keeps it, since the new build takes it over.
 */
let ownScreen = false;

function enterScreen(): void {
  if (process.stdout.isTTY !== true) return;
  // Cleared as well, since a restart comes back to the screen the old build drew.
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
  ownScreen = true;
  process.once('exit', leaveScreen);
  process.once('uncaughtExceptionMonitor', leaveScreen);
}

function leaveScreen(): void {
  if (!ownScreen) return;
  ownScreen = false;
  process.stdout.write('\x1b[?25h\x1b[?1049l');
}

/** Whether a `yan serve` already answers on `port`. */
async function servingAt(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/api/hello`, { signal: AbortSignal.timeout(1500) });
    return ((await r.json()) as { yan?: unknown }).yan === 'serve';
  } catch {
    return false;
  }
}

export const command = new Command('serve')
  .description('the vault in a browser on this machine - tasks, their notes and branch, every artifact, the report to check deliverables on - kept up to date as agents push')
  .option('--port <n>', `the page's port; the vault's files are served on the next one up`, String(DEFAULT_PORT))
  .option('--every <seconds>', 'how often to fetch the vault', '10')
  .option('--no-open', 'print the address, but do not open a browser')
  .action(
    action('yan serve', async (options: { port: string; every: string; open: boolean }) => {
      const port = whole('--port', options.port, 1024, 65534);
      const everyS = whole('--every', options.every, 2, 3600);
      const dir = vaultDir();
      const name = Object.entries(readMachine().vaults).find(([, path]) => path === dir)?.[0] || readVaultJson(dir).name || 'vault';

      let restart = (): void => {};
      const server = new YanServer({ port, everyS, vaultDir: dir, vaultName: name, home: yanHome(), onNewBuild: () => restart() });
      try {
        await server.start();
      } catch (err) {
        const address = `http://localhost:${port}`;
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          if (await servingAt(port)) {
            for (const line of [...head(name), item('Page', `${cyan(address)}  ${dim('already running')}`, true), '']) out(line);
            if (options.open) openPath(address);
            return;
          }
          throw new YanError('serve_port', `port ${port} or ${port + 1} is taken by something else - pass --port <n>`);
        }
        throw err;
      }

      const address = `http://localhost:${port}`;
      enterScreen();
      for (const line of started(name, address, dir, everyS)) out(line);
      if (options.open) openPath(address);
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          leaveScreen();
          out(dim('yan serve stopped'));
          void server.stop();
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        // Never resolved: this process becomes the new one, or waits for it.
        restart = (): void => {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          ownScreen = false;
          out(`  ${dim('yan was updated here, restarting on the new build')}`);
          void server.stop().then(relaunch);
        };
      });
    }),
  );
