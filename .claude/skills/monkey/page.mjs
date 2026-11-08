#!/usr/bin/env node
/**
 * One Chromium page a monkey drives a step at a time. Each shell command an
 * agent runs starts afresh, so the browser is held by a process of its own,
 * and each step is a snippet of Playwright sent to it: the page keeps what it
 * was showing, typed and selected between steps, as it does for a person.
 *
 *   node .claude/skills/monkey/page.mjs <sandbox> open <url> [--dark] [--size 1400x900] [--video]
 *   node .claude/skills/monkey/page.mjs <sandbox> do '<js>' [--shot <name>]
 *   node .claude/skills/monkey/page.mjs <sandbox> shot <name>
 *   node .claude/skills/monkey/page.mjs <sandbox> close
 *
 * `do` runs the snippet as the body of an async function of `page` and
 * `context`, and prints what it returns, then whatever the page threw or
 * logged as an error since the last step. `--shot` and `shot` save
 * <sandbox>/evidence/<name>.png, to be looked at with the Read tool. A page
 * left for 30 minutes is closed; `--video` records every page into
 * <sandbox>/evidence/video/ until `close`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const [sandboxArg, verb, ...rest] = process.argv.slice(2);
if (sandboxArg === undefined || !existsSync(join(sandboxArg, 'SANDBOX.md'))) die('usage: page.mjs <sandbox> open|do|shot|close ...');
const sandbox = resolve(sandboxArg);
const dir = join(sandbox, 'page');
const evidence = join(sandbox, 'evidence');
const handle = join(dir, 'handle.json');

function die(message) {
  process.stderr.write(`page: ${message}\n`);
  process.exit(1);
}
const flag = (name) => rest.includes(name);
const option = (name) => {
  const at = rest.indexOf(name);
  return at < 0 ? undefined : rest[at + 1];
};

async function send(path, body) {
  if (!existsSync(handle)) die('no page open: page.mjs <sandbox> open <url> first');
  const { port, token } = JSON.parse(readFileSync(handle, 'utf8'));
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'x-token': token }, body: JSON.stringify(body) });
  } catch {
    rmSync(handle, { force: true });
    die('the page is gone (closed after 30 idle minutes, or its browser died): open it again');
  }
  const text = await r.text();
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  if (!r.ok) process.exit(1);
}

if (verb === 'open') {
  const url = rest.find((a) => !a.startsWith('--') && a !== option('--size'));
  if (url === undefined) die('open takes the url');
  if (existsSync(handle)) die('a page is already open in this sandbox: close it first');
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [process.argv[1], sandbox, 'hold', url, ...rest.filter((a) => a !== url)], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  child.unref();
  for (let i = 0; i < 300 && !existsSync(handle); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(handle)) die(`the browser did not start; see ${join(dir, 'hold.log')}`);
  await send('/do', { js: 'return { url: page.url(), title: await page.title() };' });
} else if (verb === 'do') {
  const js = rest[0];
  if (js === undefined) die("do takes a snippet: 'await page.getByText(\"Latest\").click()'");
  await send('/do', { js, shot: option('--shot') });
} else if (verb === 'shot') {
  if (rest[0] === undefined) die('shot takes a name');
  await send('/do', { js: 'return null;', shot: rest[0] });
} else if (verb === 'close') {
  if (!existsSync(handle)) process.exit(0);
  await send('/close', {});
  rmSync(handle, { force: true });
} else if (verb === 'hold') {
  await hold(rest[0]);
} else {
  die(`unknown verb '${verb ?? ''}'`);
}

/** The process that keeps the browser, and runs each step sent to it. */
async function hold(url) {
  const log = (line) => writeFileSync(join(dir, 'hold.log'), `${line}\n`, { flag: 'a' });
  try {
    const { chromium } = await import('playwright');
    const [w, h] = (option('--size') ?? '1400x900').split('x').map(Number);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      colorScheme: flag('--dark') ? 'dark' : 'light',
      ...(flag('--video') ? { recordVideo: { dir: join(evidence, 'video'), size: { width: w, height: h } } } : {}),
    });
    const said = [];
    const watch = (page) => {
      page.on('pageerror', (e) => said.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') said.push(`console.${m.type()}: ${m.text()}`);
      });
      page.on('requestfailed', (r) => said.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
      page.on('response', (r) => {
        if (r.status() >= 500) said.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`);
      });
    };
    context.on('page', watch);
    const first = await context.newPage();
    await first.goto(url);

    const token = randomBytes(16).toString('hex');
    let idle;
    const finish = async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      rmSync(handle, { force: true });
      process.exit(0);
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(finish, 30 * 60_000);
    };
    touch();
    const AsyncFunction = (async () => {}).constructor;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        if (req.headers['x-token'] !== token) return res.writeHead(403).end('wrong token\n');
        touch();
        if (req.url === '/close') {
          res.end('closed\n');
          return finish();
        }
        const { js, shot } = JSON.parse(body);
        const pages = context.pages();
        const page = pages.at(-1) ?? (await context.newPage());
        let out;
        let ok = true;
        try {
          const value = await new AsyncFunction('page', 'context', js)(page, context);
          out = value === undefined ? 'ok' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        } catch (e) {
          ok = false;
          out = `threw: ${(e instanceof Error ? e.message : String(e)).replace(/\x1b\[[0-9;]*m/g, "")}`;
        }
        if (shot) {
          mkdirSync(evidence, { recursive: true });
          const file = join(evidence, `${shot}.png`);
          await page.screenshot({ path: file }).then(() => (out += `\nshot: ${file}`), (e) => (out += `\nshot failed: ${e.message}`));
        }
        const news = said.splice(0);
        if (news.length > 0) out += `\n--- the page said, since the last step:\n${news.join('\n')}`;
        if (pages.length > 1) out += `\n(${pages.length} pages open; steps run on the newest)`;
        res.writeHead(ok ? 200 : 500).end(`${out}\n`);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      writeFileSync(handle, JSON.stringify({ port: server.address().port, token, pid: process.pid }));
    });
  } catch (e) {
    log(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  }
}
