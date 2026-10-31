import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { fxGit, mkClone, mkEmptyRemote, mkTempDir, mkYanHome } from '../helpers/fixtures.js';

/**
 * The page in Chromium against a real `yan serve`, on a vault of the test's
 * own: what `user` sees when an agent pushes, and what reaches origin when
 * they act on the page. Nothing is stood in for but herdr, where a flow
 * needs one.
 */

export function write(dir: string, rel: string, body: string | Buffer): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

export const taskJson = (id: string, title: string, more: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ version: 2, id, title, state: 'open', repos: [], nextDeliverable: 2, deliverables: [{ id: 'd1', text: 'it works', status: 'todo' }], resources: {}, ...more }, null, 2)}\n`;

/** A vault with an origin, seeded by `seed` and pushed: its home, its bare origin, and a second clone to push from. */
export async function vault(seed: (home: string) => void): Promise<{ home: string; origin: string; elsewhere: string; machine: string }> {
  const root = mkTempDir('yan-e2e-');
  const home = mkYanHome(join(root, 'home'), { withDist: true });
  const origin = await mkEmptyRemote(join(root, 'vault.git'));
  seed(home);
  await fxGit(['init', '-q', '--initial-branch=main'], home);
  await fxGit(['add', '-A'], home);
  await fxGit(['commit', '-q', '-m', 'seed'], home);
  await fxGit(['remote', 'add', 'origin', origin], home);
  await fxGit(['push', '-q', '-u', 'origin', 'main'], home);
  const elsewhere = await mkClone(origin, join(root, 'elsewhere'));
  return { home, origin, elsewhere, machine: join(home, '.machine') };
}

/** Commit everything in `dir` and push it, as an agent's hook does. */
export async function push(dir: string, message: string): Promise<void> {
  await fxGit(['add', '-A'], dir);
  await fxGit(['commit', '-q', '-m', message], dir);
  await fxGit(['push', '-q', 'origin', 'HEAD'], dir);
}

async function freePorts(): Promise<number> {
  const taken = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(true));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(false)));
    });
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 20_000);
    if (!(await taken(p)) && !(await taken(p + 1))) return p;
  }
}

export interface Served {
  readonly url: (path?: string) => string;
  readonly process: ChildProcess;
  readonly stop: () => Promise<void>;
}

/** `yan serve` on the vault in `home`, ticking every two seconds, as often as it will. */
export async function serve(home: string, env: Readonly<Record<string, string>> = {}): Promise<Served> {
  const port = await freePorts();
  const child = spawn(process.execPath, [join(home, 'bin', 'yan.mjs'), 'serve', '--no-open', '--port', String(port), '--every', '2'], {
    env: { ...process.env, YAN_HOME: home, YAN_VAULT: home, YAN_MACHINE_DIR: join(home, '.machine'), ...env },
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('Ctrl+C to stop')) resolve();
    });
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('exit', (code) => reject(new Error(`yan serve exited ${code}: ${out}`)));
  });
  return {
    url: (path = '/') => `http://localhost:${port}${path}`,
    process: child,
    stop: async () => {
      if (child.exitCode !== null) return;
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      // A serve that outlives its signal is a finding, said with what it still runs; the run goes on without it.
      const late = setTimeout(() => {
        const left = spawnSync('ps', ['-o', 'pid,stat,args', '--ppid', String(child.pid)], { encoding: 'utf8' }).stdout ?? '';
        process.stderr.write(`yan serve (pid ${child.pid}) was still running 10 s after SIGTERM; killed. Its children:\n${left}\n`);
        child.kill('SIGKILL');
      }, 10_000);
      await gone;
      clearTimeout(late);
    },
  };
}

let browser: Browser | undefined;

/** A fresh browser page, the one browser shared by the file; whatever the page throws fails the test that reads `errors`. */
export async function open(url: string): Promise<{ page: Page; errors: string[] }> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.goto(url);
  return { page, errors };
}

/** Close the browser; one that has not closed in ten seconds is left for vitest's exit to end. */
export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = undefined;
  if (b === undefined) return;
  await Promise.race([b.close(), new Promise<void>((resolve) => setTimeout(() => {
    process.stderr.write('Chromium had not closed 10 s after it was asked to.\n');
    resolve();
  }, 10_000))]);
}
