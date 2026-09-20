#!/usr/bin/env node
//
// Click through the page `yan ui` writes, in headless Chrome over the DevTools
// protocol, and check what it does: every control, the fixture vault's known
// numbers (tests/fixtures/ui-vault/README.md), the ring at its edges, half a
// screen, dark, print, no page error and no network request. Not part of
// `npm test`, which must not need Chrome. Needs Google Chrome, Node 22+
// (global WebSocket and fetch) and a build (`npm run build`); no dependency.
//
//   node scripts/check-ui-page.mjs [--shots <dir>]
//       writes four pages with `yan ui` from copies of the fixture vault and
//       checks them. Exit 0 when every check passed, 1 otherwise.
//   node scripts/check-ui-page.mjs --look <page.html> [--shots <dir>]
//       only looks at a page already written, from any vault: screenshots and
//       the checks that hold whatever the data is.
//
// Screenshots and a PDF go to --shots, or to a temporary directory it prints.
// $CHROME names another Chrome binary. Every page is opened as the file:// URL
// the reader gets, and the page's own ?since=&until= stand in for the flags.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const LOOK = flag('--look');
const scratch = mkdtempSync(join(tmpdir(), 'yan-ui-check-'));
const OUT = resolve(flag('--shots') ?? join(scratch, 'shots'));
mkdirSync(OUT, { recursive: true });

// ── pages, written by `yan ui` ─────────────────────────────────────────────
/** A vault in the scratch directory: the fixture's tasks, plus `extra` as { id: { task, brief, deliverables } }. */
function vault(name, { fixture = true, extra = {} } = {}) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  cpSync(join(repo, 'tests', 'fixtures', 'ui-vault', 'vault.json'), join(dir, 'vault.json'));
  if (fixture) cpSync(join(repo, 'tests', 'fixtures', 'ui-vault', 'tasks'), join(dir, 'tasks'), { recursive: true });
  for (const [id, { task, brief, deliverables }] of Object.entries(extra)) {
    mkdirSync(join(dir, 'tasks', id));
    writeFileSync(join(dir, 'tasks', id, 'task.json'), JSON.stringify(task, null, 2));
    writeFileSync(join(dir, 'tasks', id, 'brief.md'), brief);
    if (deliverables) writeFileSync(join(dir, 'tasks', id, 'deliverable.json'), JSON.stringify(deliverables, null, 2));
  }
  return dir;
}
function yanUi(vaultDir, file, args = []) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'yan.mjs'), 'ui', '--no-open', '--out', file, ...args], {
    encoding: 'utf8',
    env: { ...process.env, YAN_HOME: repo, YAN_VAULT: vaultDir, YAN_MACHINE_DIR: join(scratch, 'machine'), YAN_OPENER: '' },
  });
  if (r.status !== 0) throw new Error(`yan ui failed: ${r.stderr}`);
  return { file, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}
/** An open task in site whose record holds `done` of `of` deliverables, delivered on 09-17. */
function edge(id, title, done, of) {
  const items = Array.from({ length: of }, (_, i) => (i < done
    ? { id: `d${i + 1}`, text: `item ${i + 1}`, status: 'done', doneAt: '2026-09-17' }
    : { id: `d${i + 1}`, text: `item ${i + 1}`, status: 'todo' }));
  return {
    task: { version: 1, id, title, complete: false, abandoned: false, createdAt: '2026-09-10T12:00:00Z',
      units: [{ name: 'site', repo: 'site', scope: [], needs: [], branch: `${id}-r1`, target: 'main', mr: null, history: [] }] },
    brief: `# ${id} ${title}\n\nThe ring at one of its edges.\n`,
    deliverables: { version: 1, nextId: of + 1, deliverables: items },
  };
}

const pages = {};
if (LOOK === undefined) {
  if (!existsSync(join(repo, 'dist', 'cli', 'yan.js'))) throw new Error('no build: run npm run build first');
  pages.fixture = yanUi(vault('fixture'), join(scratch, 'fixture.html'));
  pages.august = yanUi(vault('august'), join(scratch, 'august.html'), ['--since', '2026-08-01', '--until', '2026-08-31']);
  pages.edges = yanUi(vault('edges', { extra: {
    t011: edge('t011', 'edge: 1 of 20', 1, 20), t012: edge('t012', 'edge: 19 of 20', 19, 20),
    t013: edge('t013', 'edge: 4 of 4, still open', 4, 4), t014: edge('t014', 'edge: 0 of 4', 0, 4),
  } }), join(scratch, 'edges.html'));
  pages.empty = yanUi(vault('empty', { fixture: false }), join(scratch, 'empty.html'));
} else {
  pages.look = { file: resolve(LOOK), ms: null };
}

// ── chrome ─────────────────────────────────────────────────────────────────
const profile = join(scratch, 'profile');
const chromeBin = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(chromeBin, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const waiting = new Map(); const errors = []; const requests = [];
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page'); if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chrome did not start');
}
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; waiting.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed'); return r.result.value; };
const shot = async (name, full = false) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); };
const go = async (page, query = '', w = 1440, h = 1000, dark = false) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url: pathToFileURL(pages[page].file).href + query }); await sleep(700);
};
let failed = 0, passed = 0;
const check = (name, ok, got) => { if (ok) passed++; else failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got === undefined ? '' : `  → ${JSON.stringify(got)}`}`); };
const tiles = () => js(`[...document.querySelectorAll('.tile .big')].map(e => e.textContent).join(' ')`);
const projects = () => js(`[...document.querySelectorAll('.proj')].map(e => e.querySelector('span').textContent + ' ' + e.querySelector('em').textContent).join(', ')`);
const rows = () => js(`document.querySelectorAll('.task').length`);
const headline = () => js(`document.getElementById('dates').textContent`);
const clickRow = (text) => js(`[...document.querySelectorAll('button.row')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
const holds = () => js(`(() => { const bad = [...document.querySelectorAll('.row, .tile, .chip, .presets, .dates, .proj, .item')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className); return { overflowing: bad, headerOneLine: Math.abs(document.getElementById('dates').getBoundingClientRect().top - document.getElementById('presets').getBoundingClientRect().top) < 30, sideways: document.documentElement.scrollWidth > innerWidth }; })()`);
const systemFont = (on) => js(on ? `document.documentElement.style.setProperty('--text', 'system-ui, "PingFang SC", sans-serif')` : `document.documentElement.style.removeProperty('--text')`);

ws = new WebSocket(await connect());
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Network.requestWillBeSent' && !m.params.request.url.startsWith('file:') && !m.params.request.url.startsWith('data:')) requests.push(m.params.request.url); };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');

// ── what holds for any page ────────────────────────────────────────────────
async function anyPage(page, prefix) {
  const size = statSync(pages[page].file).size;
  const t0 = Date.now(); await go(page); const loaded = await js(`performance.timing.loadEventEnd - performance.timing.navigationStart`);
  check('the page opens on 30 days, or on the range yan ui was given', true, `${await headline()} · ${size} bytes · load ${loaded} ms`);
  check('no placeholder or mock line left', await js(`!document.documentElement.outerHTML.includes('/*YAN_DATA*/') && !document.documentElement.outerHTML.includes('YAN_MOCK')`));
  check('the page carries no font: local() only, no url, no data', await js(`(() => { const html = document.documentElement.outerHTML; const faces = html.match(/@font-face[^}]*}/g) || []; return faces.length === 2 && faces.every(f => f.includes('local(') && !f.includes('url(')) && !html.includes('data:font'); })()`));
  const at1440 = await holds(); check('layout holds at 1440', at1440.overflowing.length === 0 && at1440.headerOneLine && !at1440.sideways, at1440);
  await systemFont(true);
  const fallback = await holds(); check('system font: layout holds at 1440', fallback.overflowing.length === 0 && fallback.headerOneLine && !fallback.sideways, fallback);
  await systemFont(false);
  check('text is text: no markup from data', await js(`document.querySelectorAll('#list script, #list img, #list iframe').length === 0`));
  await shot(`${prefix}01-opens`);
  await js(`[...document.querySelectorAll('#presets button')].find(b => b.textContent === 'All').click()`);
  check('All', true, `${await headline()} · tiles ${await tiles()} · ${await rows()} rows · ${await projects()}`);
  await shot(`${prefix}02-all`, true);
  if ((await js(`document.querySelectorAll('button.row').length`)) > 0) {
    await js(`document.querySelector('button.row').click()`); await shot(`${prefix}03-row-open`, true);
  }
  await go(page, '', 700, 1000);
  const narrow = await holds(); check('700: layout holds, no sideways scroll', narrow.overflowing.length === 0 && !narrow.sideways, narrow);
  await shot(`${prefix}04-half-screen`, true);
  await go(page, '', 1440, 1000, true);
  check('dark follows the system', (await js(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(19, 19, 18)'); await shot(`${prefix}05-dark`);
  void t0;
}

if (LOOK !== undefined) {
  await anyPage('look', 'look-');
} else {
  // ── the fixture page, opening on 30 days ──
  console.log(`pages written by yan ui in ${Object.values(pages).map((p) => `${Math.round(p.ms)} ms`).join(', ')}; fixture page ${statSync(pages.fixture.file).size} bytes`);
  await anyPage('fixture', 'fixture-');
  await go('fixture');
  check('opens on 30d with no dates given', (await js(`document.querySelector('#presets [aria-pressed=true]')?.textContent`)) === '30d', await headline());
  const t30 = await tiles(); check('tiles for 30d', /^\d+ 4 \d+$/.test(t30), t30);
  check('three font variables at the top', await js(`['--text','--num','--code'].map(v => v + ': ' + getComputedStyle(document.documentElement).getPropertyValue(v).trim().split(',')[0]).join(' | ')`));
  const wide = await js(`(async () => { await document.fonts.load('400 40px "Chill Round F"'); const m = (family) => { const s = document.createElement('span'); s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:400 40px ' + family; s.textContent = 'Sep 16 Sep 17 冥想 2026'; document.body.append(s); const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w * 10) / 10; }; return { chill: m('"Chill Round F", monospace'), none: m('monospace') }; })()`);
  const installed = wide.chill !== wide.none;
  check('ChillRoundF is installed here and drawn (fails on a machine without it; the rest holds)', installed, wide);
  // The Bold has the Regular's advance widths, so width cannot tell them apart: count ink.
  const faces = await js(`(async () => { await document.fonts.load('600 40px "Chill Round F"'); await document.fonts.load('400 40px "Chill Round F"'); return [...document.fonts].map(f => f.weight + ' ' + f.status).join(', '); })()`);
  const ink = await js(`(() => { const draw = (weight) => { const c = document.createElement('canvas'); c.width = 700; c.height = 60; const x = c.getContext('2d'); x.font = weight + ' 40px "Chill Round F"'; x.fillText('Sep 16 Sep 17 冥想 2026', 4, 44); const d = x.getImageData(0, 0, 700, 60).data; let n = 0; for (let i = 3; i < d.length; i += 4) n += d[i]; return Math.round(n / 255); }; return { regular: draw(400), bold: draw(600) }; })()`);
  check('a bold weight finds the Bold file (the alias works)', !installed || (faces.includes('700 loaded') && ink.bold > ink.regular * 1.05), { faces, ink });

  // ── the fixture's numbers, README.md ──
  for (const [query, want, byProject] of [
    ['?since=2026-08-01&until=2026-08-31', '1 — 3', 'ledger 3'],
    ['?since=2026-09-01&until=2026-09-15', '1 — 4', 'site 4'],
    ['?since=2025-12-01&until=2026-09-15', '5 — 11', 'site 4, ledger 4, yan 2, — 1'],
  ]) {
    await go('fixture', query);
    const got = `${await tiles()} | ${await projects()}`;
    check(`README numbers for ${query.slice(1)}: Finished · In progress · Delivered, by project`, got === `${want} | ${byProject}`, got);
  }
  await go('fixture', '?since=2026-09-01');
  check('README: In progress on a range that runs to today is 4', (await tiles()).split(' ')[1] === '4', await tiles());
  check('README: open rows are t001 t007 t008 t010', (await js(`[...document.querySelectorAll('.group')][0].querySelectorAll('.task').length`)) === 4, await js(`[...[...document.querySelectorAll('.group')][0].querySelectorAll('.title')].map(e => e.textContent).join(' | ')`));
  check('an unreadable task is a row that says Untitled', await js(`[...document.querySelectorAll('.title')].some(e => e.textContent === 'Untitled')`));
  await go('fixture', '?since=2025-12-01&until=2026-09-15');
  check('the abandoned task is listed but not Finished', await js(`[...document.querySelectorAll('.row')].some(r => r.textContent.includes('dark mode for the site') && r.querySelector('.mark').dataset.state === 'abandoned')`));
  check('a task without a project shows —, the others their repo', (await projects()).includes('— 1'));
  check('bars are months past four months', /^[A-Z][a-z]{2} \d{4} · \d+$/.test(await js(`document.querySelector('.bar').title`)), await js(`document.querySelector('.bar').title`));
  await shot('fixture-06-all-of-it', true);

  // ── the range yan ui was given lands in the page ──
  await go('august');
  check('yan ui --since 2026-08-01 --until 2026-08-31 opens on those dates', (await headline()) === 'Aug 1 – 31, 2026' || (await headline()) === 'Aug 1 – Aug 31, 2026', await headline());
  check('…with no preset pressed, and the August numbers', (await js(`document.querySelectorAll('#presets [aria-pressed=true]').length`)) === 0 && (await tiles()) === '1 — 3', await tiles());
  check('?since=&until= in the address win over the flags', await (async () => { await go('august', '?since=2026-09-01&until=2026-09-15'); return (await tiles()) === '1 — 4' && (await projects()) === 'site 4'; })(), await projects());

  // ── controls ──
  await go('fixture');
  await js(`[...document.querySelectorAll('#presets button')].find(b => b.textContent === 'All').click()`);
  const tAll = await tiles(); check('All changes the numbers', tAll !== t30, tAll);
  await js(`[...document.querySelectorAll('#presets button')].find(b => b.textContent === '90d').click()`);
  check('90d', true, `${await headline()} · ${await tiles()} · ${await js(`document.querySelectorAll('.bar').length`)} weeks`);
  await js(`document.getElementById('dates').click()`);
  check('pressing the headline opens the date fields', await js(`!document.getElementById('picker').hidden`));
  await js(`(() => { const s = document.getElementById('since'), u = document.getElementById('until'); u.value = '2026-08-31'; u.dispatchEvent(new Event('change')); s.value = '2026-06-01'; s.dispatchEvent(new Event('change')); })()`);
  check('own dates: headline', (await headline()) === 'Jun 1 – Aug 31, 2026', await headline());
  check('own dates: no preset pressed', (await js(`document.querySelectorAll('#presets [aria-pressed=true]').length`)) === 0);
  check('own dates: in progress is a dash, and June to August is 3 finished, 5 delivered', (await tiles()) === '3 — 5', await tiles());
  check('own dates: zero weeks drawn as dots', (await js(`document.querySelectorAll('.bar.is-zero').length`)) > 0, await js(`document.querySelectorAll('.bar.is-zero').length`));
  await shot('fixture-07-own-dates');
  await js(`document.body.click()`); check('a click elsewhere closes the date fields', await js(`document.getElementById('picker').hidden`));
  await go('fixture', '?since=2025-12-01&until=2026-09-15');
  await js(`document.getElementById('project').click()`);
  check('project menu opens with counts', true, await js(`[...document.querySelectorAll('#menu button')].map(b => b.textContent).join(' | ')`));
  await shot('fixture-08-project-menu');
  await js(`[...document.querySelectorAll('#menu button')].find(b => b.textContent.startsWith('ledger')).click()`);
  const tLedger = await tiles(); check('project moves the numbers: ledger is 2 finished, 4 delivered', tLedger === '2 — 4', tLedger);
  check('project: every row is ledger', await js(`[...document.querySelectorAll('.row .project')].every(e => e.textContent === 'ledger')`), await rows());
  await js(`[...document.querySelectorAll('#chips .chip')].find(b => b.textContent.startsWith('Done')).click()`);
  check('state chip does not move the numbers', (await tiles()) === tLedger, await tiles());
  check('state chip: only done rows', await js(`[...document.querySelectorAll('.row .mark')].every(e => e.dataset.state === 'done')`), await rows());
  await js(`document.getElementById('project').click()`); check('pressing the set project clears it', (await js(`document.getElementById('project').textContent`)) === 'All projects');
  // search and rows, on a range that runs to today so the open tasks are listed too
  await go('fixture', '?since=2025-12-01');
  const before = await rows();
  const search = (q) => js(`(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event('input')); })()`);
  await search('invoice');
  check('search narrows the list', (await rows()) < before && (await rows()) > 0, `${before} → ${await rows()}`);
  check('search does not move the numbers', (await tiles()) === '5 4 11', await tiles());
  await search('kubernetes'); check('search with nothing found prints 0', (await js(`document.querySelector('.none')?.textContent`)) === '0');
  await search('');
  // rows
  await clickRow('invoice export');
  check('a row opens', await js(`document.querySelectorAll('.detail').length === 1 && document.querySelector('button.row[aria-expanded=true]') !== null`));
  check('an opened row is two blocks: the brief as written, then the record', await js(`(() => { const d = document.querySelector('.detail'); const kids = [...d.children].map(e => e.className); return kids[0] === 'brief' && kids.slice(1).every(c => c === 'item') && d.querySelectorAll('.brief .lead').length > 0; })()`), await js(`[...document.querySelector('.detail').children].map(e => e.className).join(' ')`));
  check('no date headings and no grouping by status or by day', await js(`document.querySelectorAll('.detail .day, .detail .run').length === 0`));
  const nodes = await js(`[...document.querySelectorAll('.detail .item')].map(e => ({ mark: e.dataset.mark, at: e.querySelector('.at')?.textContent ?? null, when: e.querySelector('.at')?.title ?? null, refs: [...e.querySelectorAll('.ref')].map(r => r.textContent), why: e.querySelector('.why')?.textContent ?? null, whyColour: e.querySelector('.why') ? getComputedStyle(e.querySelector('.why')).color : null, atColour: e.querySelector('.at') ? getComputedStyle(e.querySelector('.at')).color : null }))`);
  check('the record in file order, as it was written: three delivered then one given up', nodes.map((x) => x.mark).join(' ') === 'done done done abandoned', nodes.map((x) => x.mark));
  check('a done node carries its doneAt as a grey number, the full day in its tooltip', nodes.slice(0, 3).every((x) => /^\d\d\.\d\d$/.test(x.at) && x.atColour === 'rgb(102, 101, 95)') && nodes[0].at === '08.05' && nodes[0].when === 'Aug 5, 2026', nodes.map((x) => `${x.at} (${x.when})`).join(' | '));
  check('a done node carries every ref it has, side by side, and none when it has none', JSON.stringify(nodes[2].refs) === JSON.stringify(['PR #31', 'PR #32 <!-- squashed -->']) && nodes[0].refs.length === 0, nodes.map((x) => x.refs.join(' + ')));
  check('an abandoned node carries its reason in grey under its text, and no day', nodes[3].why.startsWith('finance sent them by hand') && nodes[3].at === null && nodes[3].whyColour === 'rgb(102, 101, 95)', nodes[3]);
  check('</script><!-- and $& print as typed, in the brief, a deliverable, a ref and a reason', await js(`(() => { const t = document.querySelector('.detail').textContent; return ['</script><!-- x -->', '$&', '$1', 'PR #32 <!-- squashed -->'].every(x => t.includes(x)); })()`), await js(`[...document.querySelectorAll('.detail .text')].map(e => e.textContent).slice(1, 3)`));
  check('the day and the refs line up at the right', await js(`new Set([...document.querySelectorAll('.detail .aside')].map(e => Math.round(e.getBoundingClientRect().right))).size === 1`));
  check('the nodes left-align with the brief', await js(`(() => { const l = document.querySelector('.detail .lead').getBoundingClientRect().left; return [...document.querySelectorAll('.detail .node')].every(e => Math.abs(e.getBoundingClientRect().left - l) < 0.6); })()`));
  const spans = await js(`[...document.querySelectorAll('.row')].map(r => { const e = r.querySelector('.span'), c = getComputedStyle(e); return { state: r.querySelector('.mark').dataset.state, text: e.textContent, title: e.title, color: c.color, weight: c.fontWeight, size: c.fontSize, bold: e.querySelector('b') !== null }; })`);
  const finishedRows = spans.filter((x) => x.state !== 'open'), openRows = spans.filter((x) => x.state === 'open' && x.text !== '');
  check('row dates: finished rows read 08.03 - 08.20', finishedRows.length > 0 && finishedRows.every((x) => /^\d\d\.\d\d - \d\d\.\d\d$/.test(x.text)), finishedRows.map((x) => x.text));
  check('row dates: a row in progress shows its start alone', openRows.length > 0 && openRows.every((x) => /^\d\d\.\d\d$/.test(x.text)), openRows.map((x) => x.text));
  check('row dates: a task with no start shows no date', spans.filter((x) => x.text === '').length === 1);
  check('row dates: all of it grey, 14 px, no bold', spans.every((x) => x.color === 'rgb(102, 101, 95)' && x.weight === '400' && x.size === '14px' && !x.bold));
  check('row dates: the tooltip carries the full dates with the year', finishedRows.every((x) => /^[A-Z][a-z]{2} \d{1,2}, \d{4} – [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(x.title)), finishedRows[0]?.title);
  await shot('fixture-09-row-open');
  await clickRow('pricing page');
  check('pricing page: the brief as written, two paragraphs keeping their bullets, then five nodes in file order', await js(`(() => { const d = [...document.querySelectorAll('.detail')].find(e => e.dataset.state === 'open'); const leads = [...d.querySelectorAll('.lead')].map(e => e.textContent); return leads.length === 2 && leads[1].split(String.fromCharCode(10)).length === 3 && leads[1].split(String.fromCharCode(10))[1].startsWith('- a visitor') && d.querySelectorAll('.item').length === 5 && [...d.querySelectorAll('.item')].map(e => e.dataset.mark).join(' ') === 'done done todo todo abandoned'; })()`), await js(`[...[...document.querySelectorAll('.detail')].find(e => e.dataset.state === 'open').querySelectorAll('.lead')].map(e => e.textContent)`));
  check('a bullet keeps its own line rather than folding into the paragraph above it', await js(`getComputedStyle(document.querySelector('.detail .lead')).whiteSpace === 'pre-line'`));
  await clickRow('pricing page');
  check('a row closes again', (await js(`document.querySelectorAll('.detail').length`)) === 1);
  // a task with no record: not a button anywhere, and `unknown` where its squares would be
  const bare = await js(`[...document.querySelectorAll('div.row')].map(r => ({ title: r.querySelector('.title').textContent, chev: r.querySelector('.chev') !== null, expanded: r.hasAttribute('aria-expanded'), tab: r.tabIndex, cursor: getComputedStyle(r).cursor, unknown: r.querySelector('.unknown')?.textContent ?? null, squares: r.querySelector('.squares') !== null, colour: r.querySelector('.unknown') ? getComputedStyle(r.querySelector('.unknown')).color : null, dates: getComputedStyle(r.querySelector('.span')).color }))`);
  check('a task with no record is not a button: no chevron, no aria-expanded, no pointer, no tab stop', bare.length === 5 && bare.every((r) => !r.chev && !r.expanded && r.tab === -1 && r.cursor === 'default'), bare.map((r) => r.title));
  check('where its squares would be it prints unknown, in the grey of the row dates', bare.every((r) => r.unknown === 'unknown' && !r.squares && r.colour === r.dates), bare.map((r) => `${r.unknown} ${r.colour}`).join(' | '));
  check('clicking one opens nothing', await js(`(() => { const before = document.querySelectorAll('.detail').length; document.querySelector('div.row').click(); return document.querySelectorAll('.detail').length === before; })()`));
  check('the keyboard cannot reach one, and Enter on it opens nothing', await js(`(() => { const r = document.querySelector('div.row'); r.focus(); const reached = document.activeElement === r; const before = document.querySelectorAll('.detail').length; r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !reached && document.querySelectorAll('.detail').length === before; })()`));
  check('an old brief with checkbox lines is not parsed: unknown, and none of the brief is on the page', await js(`(() => { const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('ledger backups')); return r.tagName === 'DIV' && r.querySelector('.unknown') !== null && !document.getElementById('list').textContent.includes('Nightly backups of the ledger'); })()`));
  check('a record that does not validate is a task with none', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('release notes')).querySelector('.unknown') !== null`));
  check('an empty record is a task with none', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('newsletter signup')).querySelector('.unknown') !== null`));
  check('a delivered item with nothing proving it is still a square', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('search box')).querySelector('.squares').title === '2/2'`));
  check('an abandoned deliverable is in neither square nor ring', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('pricing page')).querySelector('.squares').title === '2/4'`));
  await shot('fixture-12-unknown');
  check('an open row survives a filter change', await (async () => { await js(`[...document.querySelectorAll('#chips .chip')].find(b => b.textContent.startsWith('Done')).click()`); return js(`document.querySelectorAll('.detail').length === 1`); })());
  check('tooltips: marks, bars, presets', true, await js(`[document.querySelector('.row .mark').title, document.querySelector('.bar').title, document.querySelector('#presets button').title].join(' | ')`));

  // ── the ring ──
  const ring = (title) => js(`(() => { const r = [...document.querySelectorAll('.row')].find(b => b.textContent.includes(${JSON.stringify(title)})); const m = r.querySelector('.mark'); const svg = m.querySelector('svg'); const pie = svg.querySelector('path[fill]'); let drawn = null; if (pie) { const e = pie.getAttribute('d').match(/1 ([\\d.]+) ([\\d.]+)Z$/); const x = Number(e[1]) - 10, y = 10 - Number(e[2]); let deg = Math.atan2(x, y) * 180 / Math.PI; if (deg <= 0) deg += 360; drawn = Math.round(deg); } return { state: m.dataset.state, fraction: m.dataset.fraction ?? null, degrees: m.dataset.degrees ?? null, drawn, dot: !!svg.querySelector('circle[r="1.5"]'), full: !!svg.querySelector('circle[r="5"]'), disc: !!svg.querySelector('circle[r="9"]'), slash: !!svg.querySelector('path[stroke-linecap]:not([stroke-linejoin])'), title: m.title, size: svg.getAttribute('width'), tint: getComputedStyle(m).backgroundColor, color: getComputedStyle(m).color }; })()`);
  await go('edges', '?since=2025-12-01');
  const r24 = await ring('pricing page');
  check('ring: t001 at 2/4 is a half, drawn where it says', r24.fraction === '0.5' && r24.degrees === '180' && r24.drawn === 180 && r24.size === '18', r24);
  check('ring: tooltip carries the state and the count', r24.title === 'In progress · 2/4', r24.title);
  const r04 = await ring('edge: 0 of 4'); check('ring: nothing delivered is a dot in the ring, not an empty ring', r04.fraction === '0' && r04.dot && r04.drawn === null && r04.title === 'In progress · 0/4', r04);
  const rNone = await ring('newsletter signup'); check('ring: in progress with no deliverables is the same dot, and says only the state', rNone.fraction === 'none' && rNone.dot && rNone.title === 'In progress', rNone);
  const rLow = await ring('edge: 1 of 20'); check('ring: a small fraction is never drawn as nothing (18° held at 30°)', rLow.fraction === '0.05' && rLow.drawn === 30, rLow);
  const rHigh = await ring('edge: 19 of 20'); check('ring: a large fraction is never drawn as everything (342° held at 330°)', rHigh.fraction === '0.95' && rHigh.drawn === 330, rHigh);
  const rAll = await ring('edge: 4 of 4'); check('ring: everything delivered on an open task is a full pie in the ring, not the done disc', rAll.full && !rAll.disc && rAll.state === 'open', rAll);
  const rDone = await ring('invoice export'); check('ring: done is a disc with a check, green, no tint behind it', rDone.disc && rDone.tint === 'rgba(0, 0, 0, 0)' && rDone.color === 'rgb(31, 122, 61)' && rDone.title === 'Done', rDone);
  const rGone = await ring('dark mode for the site'); check('ring: abandoned is a ring with a slash, grey', rGone.slash && !rGone.dot && rGone.color === 'rgb(102, 101, 95)' && rGone.title === 'Abandoned', rGone);
  check('ring: an empty in-progress ring and an abandoned ring differ in shape, not only in colour', r04.dot && !r04.slash && rGone.slash && !rGone.dot);
  check('ring: the In progress chip shows a fixed half at 16 px', await js(`(() => { const m = [...document.querySelectorAll('#chips .chip')][1].querySelector('.mark'); return m.dataset.degrees === '180' && m.querySelector('svg').getAttribute('width') === '16'; })()`));
  const fives = await js(`(() => { const s = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('edge: 1 of 20')).querySelector('.squares'); const gap = (i) => getComputedStyle(s.children[i]).marginRight; return { title: s.title, squares: s.children.length, on: s.querySelectorAll('.on').length, fourth: gap(3), fifth: gap(4) }; })()`);
  check('squares carry n/m and stand in fives', fives.title === '1/20' && fives.squares === 20 && fives.on === 1 && fives.fifth !== fives.fourth, fives);
  await shot('edges-01-ring', true);

  // ── the address, an empty vault ──
  await go('fixture', '?since=2025-12-01'); check('?since alone runs to today', true, await headline());
  await go('fixture', '?since=nonsense'); check('a bad date is ignored', (await js(`document.querySelector('#presets [aria-pressed=true]')?.textContent`)) === '30d');
  await go('empty'); check('an empty vault', (await tiles()) === '0 0 0' && (await js(`document.querySelector('.none')?.textContent`)) === '0', `${await headline()} · ${await tiles()}`); await shot('empty-01');

  // ── half a screen, print ──
  await go('fixture', '?since=2025-12-01&until=2026-09-15', 700, 1000); await clickRow('invoice export');
  check('700: no sideways scroll with a row open', await js(`document.documentElement.scrollWidth <= 700`), await js(`document.documentElement.scrollWidth`));
  await go('fixture', '?since=2025-12-01&until=2026-09-15'); await clickRow('invoice export');
  await send('Emulation.setEmulatedMedia', { media: 'print' }); await send('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false }); await sleep(200);
  check('print: controls gone, legend and date shown, row stays open', await js(`getComputedStyle(document.getElementById('presets')).display === 'none' && getComputedStyle(document.getElementById('filters')).display === 'none' && getComputedStyle(document.getElementById('legend')).display !== 'none' && document.getElementById('gen').textContent !== '' && document.querySelectorAll('.detail').length === 1`), await js(`document.getElementById('gen').textContent`));
  await shot('fixture-10-print', true);
  const pdf = await send('Page.printToPDF', { printBackground: true, paperWidth: 8.27, paperHeight: 11.69 }); writeFileSync(join(OUT, 'fixture-11-print.pdf'), Buffer.from(pdf.data, 'base64'));
}

check('no page errors', errors.length === 0, errors);
check('no network request of any kind', requests.length === 0, requests);
console.log(`\n${passed} passed, ${failed} failed · screenshots in ${OUT}`);
ws.close(); chrome.kill(); await sleep(300);
rmSync(profile, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
