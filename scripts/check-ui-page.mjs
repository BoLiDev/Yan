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
  // ── refs: a ref that is a URL is a link, and nothing else ever is ──
  // t001 carries one of each kind (tests/fixtures/ui-vault/README.md): a plain PR #12,
  // a GitHub pull request URL, a GitLab merge request URL on a self-hosted host, a
  // `javascript:` one and an http one carrying `"><script>`.
  const refs = await js(`(() => { const d = [...document.querySelectorAll('.detail')].find(e => e.dataset.state === 'open'); return [...d.querySelectorAll('.ref')].map(e => ({ tag: e.tagName, text: e.textContent, href: e.getAttribute('href'), target: e.getAttribute('target'), rel: e.getAttribute('rel'), title: e.getAttribute('title'), color: getComputedStyle(e).color, font: getComputedStyle(e).fontFamily })); })()`);
  check('a GitHub pull request URL reads PR #13 and links to itself, in a new tab', (() => {
    const a = refs.find((r) => r.text === 'PR #13');
    return a !== undefined && a.tag === 'A' && a.href === 'https://github.com/acme/site/pull/13' && a.target === '_blank' && a.rel === 'noopener noreferrer';
  })(), refs.find((r) => r.text === 'PR #13'));
  check('a GitLab merge request URL on a self-hosted host reads MR !14 and links to itself', (() => {
    const a = refs.find((r) => r.text === 'MR !14');
    return a !== undefined && a.tag === 'A' && a.href === 'https://gitlab.acme.internal/acme/site/-/merge_requests/14' && a.target === '_blank';
  })(), refs.find((r) => r.text === 'MR !14'));
  check('any other http URL is a link labelled with its host, and its full ref is the tooltip', (() => {
    const a = refs.find((r) => r.text === 'ref.example.com');
    return a !== undefined && a.tag === 'A' && a.href.startsWith('https://ref.example.com/') && !a.href.includes('"') && !a.href.includes('<') && a.title === 'https://ref.example.com/a"><script>';
  })(), refs.find((r) => r.text === 'ref.example.com'));
  check('a ref that is not a URL is drawn as today: text, not a link', (() => {
    const a = refs.find((r) => r.text === 'PR #12');
    return a !== undefined && a.tag === 'SPAN' && a.href === null;
  })(), refs.find((r) => r.text === 'PR #12'));
  check('a javascript: ref is printed as typed and is never a link', (() => {
    const a = refs.find((r) => r.text === 'javascript:alert(1)');
    return a !== undefined && a.tag === 'SPAN' && a.href === null;
  })(), refs.find((r) => r.text === 'javascript:alert(1)'));
  check('no ref anywhere has a javascript: href, and the hostile text ran nothing', await js(`[...document.querySelectorAll('.ref')].every(e => !(e.getAttribute('href') || '').toLowerCase().startsWith('javascript:')) && document.querySelectorAll('#list script').length === 0`));
  check('a linked ref looks as the others do: the same grey and the same face', (() => {
    const link = refs.find((r) => r.tag === 'A'), plain = refs.find((r) => r.tag === 'SPAN');
    return link !== undefined && plain !== undefined && link.color === plain.color && link.font === plain.font;
  })(), refs.map((r) => `${r.tag} ${r.color}`).join(' | '));
  check('hover underlines it and focus rings it, which is what the page uses to say "link"', await js(`(() => { const a = document.querySelector('.detail a.ref'); const rest = getComputedStyle(a).textDecorationLine; const hover = [...document.styleSheets[0].cssRules].some(r => r.selectorText === 'a:hover' && r.style.textDecoration.includes('underline')); const ring = [...document.styleSheets[0].cssRules].some(r => r.selectorText === ':focus-visible' && r.style.outline !== ''); return rest === 'none' && hover && ring; })()`));
  check('clicking a ref does not toggle the row it sits in', await js(`(() => { const detail = [...document.querySelectorAll('.detail')].find(e => e.dataset.state === 'open'); const a = detail.querySelector('a.ref'); const row = detail.previousElementSibling; const before = document.querySelectorAll('.detail').length, open = row.getAttribute('aria-expanded'); a.addEventListener('click', e => e.preventDefault(), { capture: true, once: true }); a.click(); return document.querySelectorAll('.detail').length === before && row.getAttribute('aria-expanded') === open && open === 'true'; })()`));
  const wideRow = `(() => { const d = [...document.querySelectorAll('.detail')].find(e => e.dataset.state === 'open'); const item = [...d.querySelectorAll('.item')].find(e => e.querySelectorAll('.ref').length > 2); return { refs: item.querySelectorAll('.ref').length, over: item.scrollWidth > item.clientWidth + 1, sideways: document.documentElement.scrollWidth > innerWidth }; })()`;
  check('three refs on one deliverable hold their line at 1440', await (async () => { const r = await js(wideRow); return r.refs === 3 && !r.over && !r.sideways; })(), await js(wideRow));
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(200);
  check('…and at 700, where the aside moves under the text', await (async () => { const r = await js(wideRow); return r.refs === 3 && !r.over && !r.sideways; })(), await js(wideRow));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(200);
  await shot('fixture-13-refs');
  await js(`document.querySelector('.detail a.ref').focus()`); await shot('fixture-14-ref-focus');
  await send('Emulation.setEmulatedMedia', { media: 'print' }); await sleep(150);
  check('print shows the short form and no address', await js(`(() => { const d = [...document.querySelectorAll('.detail')].find(e => e.dataset.state === 'open'); const texts = [...d.querySelectorAll('.ref')].map(e => e.textContent); return texts.includes('PR #13') && texts.includes('MR !14') && !d.textContent.includes('gitlab.acme.internal/acme'); })()`));
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(150);

  await clickRow('pricing page');
  check('a row closes again', (await js(`document.querySelectorAll('.detail').length`)) === 1);
  // a task with no record: not a button anywhere, and an empty squares column that says nothing
  const bare = await js(`[...document.querySelectorAll('div.row')].map(r => ({ title: r.querySelector('.title').textContent, chev: r.querySelector('.chev') !== null, expanded: r.hasAttribute('aria-expanded'), tab: r.tabIndex, cursor: getComputedStyle(r).cursor, blank: r.querySelector('.blank') !== null, blankText: r.querySelector('.blank')?.textContent ?? null, blankLabel: r.querySelector('.blank')?.getAttribute('aria-label') ?? null, blankTitle: r.querySelector('.blank')?.getAttribute('title') ?? null, squares: r.querySelector('.squares') !== null, meta: r.querySelector('.meta').children.length }))`);
  check('a task with no record is not a button: no chevron, no aria-expanded, no pointer, no tab stop', bare.length === 5 && bare.every((r) => !r.chev && !r.expanded && r.tab === -1 && r.cursor === 'default'), bare.map((r) => r.title));
  check('where its squares would be there is nothing at all: an empty cell, no squares, no word', bare.every((r) => r.blank && !r.squares && r.blankText === '' && r.meta === 3), bare.map((r) => `${r.title}: ${JSON.stringify(r.blankText)}`).join(' | '));
  check('the empty cell announces nothing: no label and no tooltip to read out', bare.every((r) => r.blankLabel === null && r.blankTitle === null), bare.map((r) => `${r.blankLabel} ${r.blankTitle}`).join(' | '));
  check('the word `unknown` is nowhere on the page', await js(`!document.getElementById('list').textContent.toLowerCase().includes('unknown') && !document.documentElement.outerHTML.includes('unknown')`));
  const columns = await js(`(() => { const bad = []; document.querySelectorAll('.card').forEach(card => { const lefts = new Set([...card.querySelectorAll('.row .span')].map(e => Math.round(e.getBoundingClientRect().left))); if (lefts.size > 1) bad.push([...lefts]); }); return { bad: bad, cards: document.querySelectorAll('.card').length }; })()`);
  check('the empty cell holds its column: every row in a card puts its dates in the same place', columns.bad.length === 0 && columns.cards > 0, columns);
  check('…and so do the squares of the rows above and below it', await js(`(() => { const card = [...document.querySelectorAll('.card')][0]; const cells = [...card.querySelectorAll('.row')].map(r => Math.round((r.querySelector('.squares') || r.querySelector('.blank')).getBoundingClientRect().left)); return new Set(cells).size === 1 && cells.length === 4; })()`));
  check('clicking one opens nothing', await js(`(() => { const before = document.querySelectorAll('.detail').length; document.querySelector('div.row').click(); return document.querySelectorAll('.detail').length === before; })()`));
  check('the keyboard cannot reach one, and Enter on it opens nothing', await js(`(() => { const r = document.querySelector('div.row'); r.focus(); const reached = document.activeElement === r; const before = document.querySelectorAll('.detail').length; r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !reached && document.querySelectorAll('.detail').length === before; })()`));
  check('an old brief with checkbox lines is not parsed: an empty cell, and none of the brief on the page', await js(`(() => { const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('ledger backups')); return r.tagName === 'DIV' && r.querySelector('.blank') !== null && !document.getElementById('list').textContent.includes('Nightly backups of the ledger'); })()`));
  check('a record that does not validate is a task with none', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('release notes')).querySelector('.blank') !== null`));
  check('an empty record is a task with none', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('newsletter signup')).querySelector('.blank') !== null`));
  check('a delivered item with nothing proving it is still a square', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('search box')).querySelector('.squares').title === '2/2'`));
  check('an abandoned deliverable is in neither square nor ring', await js(`[...document.querySelectorAll('.row')].find(r => r.textContent.includes('pricing page')).querySelector('.squares').title === '2/4'`));
  await shot('fixture-12-no-record');
  check('an open row survives a filter change', await (async () => { await js(`[...document.querySelectorAll('#chips .chip')].find(b => b.textContent.startsWith('Done')).click()`); return js(`document.querySelectorAll('.detail').length === 1`); })());
  check('tooltips: marks, bars, presets', true, await js(`[document.querySelector('.row .mark').title, document.querySelector('.bar').title, document.querySelector('#presets button').title].join(' | ')`));

  // ── the list folds, section by section ────────────────────────────────────
  // `In progress` is a heading like any month, and every heading is the button that folds
  // its own section. A fold hides: the numbers, the chip counts and the search go on
  // counting what is inside it.
  const heads = () => js(`[...document.querySelectorAll('.group-h')].map(e => { const c = getComputedStyle(e); return { text: e.firstChild.textContent, count: e.querySelector('em').textContent, tag: e.tagName, type: e.getAttribute('type'), expanded: e.getAttribute('aria-expanded'), controls: e.getAttribute('aria-controls'), chev: e.querySelector('.chev svg') !== null, rotated: getComputedStyle(e.querySelector('.chev')).transform, font: [c.fontFamily.split(',')[0], c.fontSize, c.fontWeight, c.gap, c.padding].join(' '), countFont: (() => { const m = getComputedStyle(e.querySelector('em')); return [m.fontFamily.split(',')[0], m.fontSize, m.fontWeight, m.color].join(' '); })(), left: Math.round(e.getBoundingClientRect().left), card: document.getElementById(e.getAttribute('aria-controls')) !== null, rows: (document.getElementById(e.getAttribute('aria-controls')) || { querySelectorAll: () => [] }).querySelectorAll('.task').length }; })`);
  const foldHead = (text) => js(`[...document.querySelectorAll('.group-h')].find(e => e.firstChild.textContent === ${JSON.stringify(text)}).click()`);
  await go('fixture', '?since=2025-12-01');
  const hs = await heads();
  check('the open tasks get a heading of their own: In progress, with its count', hs.length > 1 && hs[0].text === 'In progress' && hs[0].count === '4', hs.map((x) => `${x.text} ${x.count}`).join(' | '));
  check('In progress is drawn exactly as a month heading: face, size, count and spacing', hs.every((x) => x.font === hs[0].font && x.countFont === hs[0].countFont && x.left === hs[0].left), [...new Set(hs.map((x) => `${x.font} · ${x.countFont} · ${x.left}`))]);
  check('every heading is a real button with a chevron, and everything starts unfolded', hs.every((x) => x.tag === 'BUTTON' && x.type === 'button' && x.chev && x.expanded === 'true' && x.controls && x.card), hs.map((x) => `${x.text}: ${x.tag} ${x.expanded} chev=${x.chev}`).join(' | '));
  check('the chevron is the row\'s chevron, turned: right when folded, down when open', hs[0].rotated !== 'none', hs[0].rotated);
  check('a heading is a tab stop and the keyboard can reach it', await js(`(() => { const e = document.querySelector('.group-h'); e.focus(); return e.tabIndex === 0 && document.activeElement === e; })()`));
  // Enter on the focused heading, as a real key press rather than a click
  await js(`document.querySelector('.group-h').focus()`);
  for (const type of ['rawKeyDown', 'char', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'char' ? '\r' : undefined });
  await sleep(150);
  const byEnter = await heads();
  check('Enter on the heading folds the section: the heading and its count stay, the rows go', byEnter[0].expanded === 'false' && !byEnter[0].card && byEnter[0].text === 'In progress' && byEnter[0].count === '4' && byEnter.slice(1).every((x) => x.card), byEnter.map((x) => `${x.text} ${x.expanded} card=${x.card}`).join(' | '));
  check('…and the keyboard keeps its focus on the heading it pressed', await js(`document.activeElement === document.querySelector('.group-h')`));
  check('a folded section shows nothing but its heading and count', await js(`(() => { const s = document.querySelectorAll('.group')[0]; return s.children.length === 1 && s.textContent.trim() === 'In progress4' && s.querySelectorAll('.task, .row, .detail').length === 0; })()`), await js(`document.querySelectorAll('.group')[0].textContent`));
  await sleep(50);
  for (const type of ['rawKeyDown', 'char', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'char' ? '\r' : undefined });
  await sleep(150);
  check('Enter again unfolds it', (await heads())[0].card && (await heads())[0].expanded === 'true');

  // a fold hides, it does not filter
  const tilesBefore = await tiles(), chipsBefore = await js(`[...document.querySelectorAll('#chips .chip')].map(b => b.textContent).join(' | ')`);
  await foldHead('In progress');
  check('folding moves no number: the tiles and the chip counts are what they were', (await tiles()) === tilesBefore && (await js(`[...document.querySelectorAll('#chips .chip')].map(b => b.textContent).join(' | ')`)) === chipsBefore, `${tilesBefore} → ${await tiles()}`);
  await search('release notes');
  const searched = await heads();
  check('search still matches inside a folded section: its count follows the search', searched[0].expanded === 'false' && searched[0].count === '1', searched.map((x) => `${x.text} ${x.count} ${x.expanded}`).join(' | '));
  check('…and the section is still folded after the search', !searched[0].card);
  await search('');
  check('a folded section is still folded after the search is cleared', !(await heads())[0].card);
  await js(`[...document.querySelectorAll('#chips .chip')].find(b => b.textContent.startsWith('All')).click()`);
  check('…and after a filter change', !(await heads())[0].card);
  await js(`[...document.querySelectorAll('#presets button')].find(b => b.textContent === 'All').click()`);
  check('…and after the range changes', !(await heads())[0].card, (await heads()).map((x) => `${x.text} ${x.expanded}`).join(' | '));
  await shot('fixture-15-folded');

  // a row opened inside a section is still open when the section unfolds
  await foldHead('In progress');
  await clickRow('pricing page');
  check('a row opens inside an unfolded section', (await js(`document.querySelectorAll('.detail').length`)) === 1);
  await foldHead('In progress');
  check('folding the section around an open row takes the row with it', (await js(`document.querySelectorAll('.detail').length`)) === 0);
  await foldHead('In progress');
  check('…and unfolding brings it back open', await js(`document.querySelectorAll('.detail').length === 1 && document.querySelector('button.row[aria-expanded=true]').textContent.includes('pricing page')`));

  // print and phone
  await foldHead('In progress');
  await send('Emulation.setEmulatedMedia', { media: 'print' }); await sleep(150);
  check('print: a folded section prints folded, heading and count and no chevron', await js(`(() => { const s = document.querySelectorAll('.group')[0], h = s.querySelector('.group-h'); return s.querySelectorAll('.task').length === 0 && getComputedStyle(h).display !== 'none' && h.textContent.trim() === 'In progress4' && getComputedStyle(h.querySelector('.chev')).display === 'none'; })()`), await js(`document.querySelectorAll('.group')[0].textContent`));
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(150);
  await go('fixture', '?since=2025-12-01', 390, 844);
  const phone = await heads();
  check('390: the headings hold, and In progress is drawn as the months are', phone[0].text === 'In progress' && phone.every((x) => x.font === phone[0].font && x.left === phone[0].left) && !(await holds()).sideways, phone.map((x) => `${x.text} ${x.left}`).join(' | '));
  await foldHead('In progress');
  check('390: a heading folds its section here too, with no sideways scroll', (await heads())[0].card === false && !(await holds()).sideways);
  await shot('fixture-16-folded-phone', true);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await sleep(150);

  // ── the headline and the search row stay in reach while scrolling ────────
  // Two sticky bars: the headline with its presets at the top, the search row under it,
  // the tiles passing away between them and the list scrolling on below. What is checked
  // is where things are after a real scroll, not which CSS was written.
  const bars = () => js(`(() => {
    const head = document.getElementById('head'), filters = document.getElementById('filters');
    const r = (e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; };
    const page = document.querySelector('.page').getBoundingClientRect();
    const h = r(head), f = r(filters);
    const under = (x, y) => { const e = document.elementFromPoint(x, y); return e === null ? null : (e.closest('#head') ? 'head' : e.closest('#filters') ? 'filters' : e.closest('#list') ? 'list' : e.className || e.tagName); };
    return {
      scrollY: Math.round(scrollY), head: h, filters: f,
      bar: getComputedStyle(document.documentElement).getPropertyValue('--bar').trim(),
      position: [getComputedStyle(head).position, getComputedStyle(filters).position].join(' '),
      tilesBottom: Math.round(document.querySelector('.tiles').getBoundingClientRect().bottom),
      firstRow: Math.round(document.querySelector('.row').getBoundingClientRect().top),
      presets: Math.round(document.getElementById('presets').getBoundingClientRect().top),
      gutter: under(page.left + 6, Math.round(h.height / 2)), middle: under(page.left + page.width / 2, Math.round(h.height / 2)),
      overFilters: under(page.left + page.width / 2, f.top + Math.round(f.height / 2)),
      hairline: (() => { const c = getComputedStyle(filters, '::after'); return [c.content !== 'none', c.height, c.backgroundColor].join(' '); })(),
      hairlineTop: (() => { const c = getComputedStyle(head, '::after'); return [c.content !== 'none', c.height, c.backgroundColor].join(' '); })(),
      viewport: innerHeight,
    };
  })()`);
  const scroll = async (y) => { await js(`scrollTo(0, ${y})`); await sleep(300); };
  const toBottom = async () => { await js(`scrollTo(0, document.body.scrollHeight)`); await sleep(300); };

  await go('fixture', '?since=2025-12-01');
  const rest = await bars();
  check('the two bars are sticky and nothing else does the pinning', rest.position === 'sticky sticky' && (await js(`document.documentElement.outerHTML.includes('position: fixed') === false`)), rest.position);
  check('at rest the bars sit where they always did: the headline 56 px down, the tiles under it', rest.head.top === 42 && (await js(`Math.round(document.querySelector('.dates').getBoundingClientRect().top)`)) === 56 && rest.tilesBottom > 0, rest);
  await toBottom();
  const down = await bars();
  check('scrolled to the bottom: the headline is at the top of the viewport, with its presets beside it', down.scrollY > 300 && down.head.top === 0 && down.presets > 0 && down.presets < down.head.height, down);
  check('…the tiles are out of view entirely, gone up under the headline', down.tilesBottom <= 0, down.tilesBottom);
  check('…the search row sits right under the headline, with no gap and no overlap', down.filters.top === down.head.height && down.bar === `${down.head.height}px`, `${down.filters.top} vs ${down.head.height}, --bar ${down.bar}`);
  check('…and the list has moved by exactly what was scrolled', rest.firstRow - down.firstRow === down.scrollY, `${rest.firstRow} → ${down.firstRow}, scrolled ${down.scrollY}`);
  check('the bars are opaque in the page\'s own ground, out to the page\'s edges: nothing shows through', down.gutter === 'head' && down.middle === 'head' && down.overFilters === 'filters', down);
  check('the hairline under the pair is the page\'s own line, and costs no height', /^true 1px rgb\(231, 229, 223\)$/.test(down.hairline) && down.head.height === rest.head.height && down.filters.height === rest.filters.height, [down.hairline, rest.head.height, down.head.height, rest.filters.height, down.filters.height]);
  await shot('fixture-17-pinned', false);
  // the menus, while both bars are pinned
  await js(`document.getElementById('project').click()`);
  const menu = await js(`(() => { const m = document.getElementById('menu'); const b = m.getBoundingClientRect(); const mid = document.elementFromPoint(b.left + b.width / 2, b.top + 8); return { shown: !m.hidden, top: Math.round(b.top), bottom: Math.round(b.bottom), inside: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0, onTop: mid !== null && mid.closest('#menu') !== null, clipped: [...document.querySelectorAll('*')].some(e => e.contains(m) && e !== m && getComputedStyle(e).overflow !== 'visible') }; })()`);
  check('pinned: the project menu opens over everything, unclipped and inside the viewport', menu.shown && menu.inside && menu.onTop && !menu.clipped, menu);
  await shot('fixture-18-pinned-menu', false);
  await js(`document.body.click()`);
  await js(`document.getElementById('dates').click()`);
  const picker = await js(`(() => { const p = document.getElementById('picker'); const b = p.getBoundingClientRect(); const mid = document.elementFromPoint(b.left + b.width / 2, b.top + 8); return { shown: !p.hidden, top: Math.round(b.top), inside: b.top >= 0 && b.bottom <= innerHeight, onTop: mid !== null && mid.closest('#picker') !== null, overFilters: b.bottom > document.getElementById('filters').getBoundingClientRect().top }; })()`);
  check('pinned: the headline\'s own dates open over the search row below it, unclipped', picker.shown && picker.inside && picker.onTop && picker.overFilters, picker);
  await js(`document.body.click()`);
  // the keyboard: a real Tab onto a row far down the list lands below the bars
  await scroll(0);
  await js(`(() => { const hs = [...document.querySelectorAll('.group-h')]; hs[hs.length - 1].focus(); })()`);
  await sleep(250);
  let tabs = 0;
  while (tabs < 12 && !(await js(`document.activeElement.matches('button.row')`))) {
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    tabs++; await sleep(200);
  }
  const landed = await js(`(() => { const e = document.activeElement, b = e.getBoundingClientRect(); const f = document.getElementById('filters').getBoundingClientRect(); return { what: e.className, text: e.textContent.slice(0, 24), row: e.matches('button.row'), top: Math.round(b.top), bottom: Math.round(b.bottom), barsBottom: Math.round(f.bottom), viewport: innerHeight, scrolled: Math.round(scrollY), clear: b.top >= f.bottom - 0.5 && b.bottom <= innerHeight + 0.5 }; })()`);
  check('Tab onto a row far down the list leaves it whole, below both bars', landed.row && landed.clear && landed.scrolled > 0, { tabs, ...landed });
  await shot('fixture-19-pinned-tab', false);
  // a section heading jumped to: scroll-margin-top keeps it clear of the bars too
  const heading = await js(`(() => { const hs = [...document.querySelectorAll('.group-h')]; const h = hs[hs.length - 1]; h.focus(); return h.firstChild.textContent; })()`);
  await sleep(300);
  check('a section heading the keyboard reaches is clear of the bars as well', await js(`(() => { const b = document.activeElement.getBoundingClientRect(); const f = document.getElementById('filters').getBoundingClientRect(); return b.top >= f.bottom - 0.5 && b.bottom <= innerHeight + 0.5; })()`), heading);

  // a phone pins the headline alone: both bars would cost a third of the screen there
  await go('fixture', '?since=2025-12-01', 390, 844);
  const phoneRest = await bars();
  check('390: at rest the search row is where it always was, under the tiles', phoneRest.position === 'sticky static' && phoneRest.filters.top > phoneRest.tilesBottom, phoneRest);
  await toBottom();
  const phonePinned = await bars();
  check('390 × 844: the headline is pinned with its presets, the tiles and the search row gone up under it', phonePinned.head.top === 0 && phonePinned.presets > 0 && phonePinned.tilesBottom <= 0 && phonePinned.filters.bottom <= phonePinned.head.height, phonePinned);
  check('390 × 844: what is pinned takes well under a third of the screen and the list keeps the rest', phonePinned.head.height <= 281, `${phonePinned.head.height} of 844 (${Math.round((phonePinned.head.height / 844) * 100)}%)`);
  check('390: the bar is opaque out to the page\'s edges, with the same hairline under it', phonePinned.gutter === 'head' && phonePinned.middle === 'head' && /^true 1px rgb\(231, 229, 223\)$/.test(phonePinned.hairlineTop), [phonePinned.gutter, phonePinned.hairlineTop]);
  check('390: and the list has moved by exactly what was scrolled', phoneRest.firstRow - phonePinned.firstRow === phonePinned.scrollY, `${phoneRest.firstRow} → ${phonePinned.firstRow}, scrolled ${phonePinned.scrollY}`);
  check('390: no sideways scroll with the headline pinned', !(await holds()).sideways);
  await shot('fixture-20-pinned-phone', false);
  await js(`document.getElementById('dates').click()`);
  check('390: the headline\'s own dates open unclipped while pinned', await js(`(() => { const p = document.getElementById('picker'), b = p.getBoundingClientRect(); const mid = document.elementFromPoint(b.left + b.width / 2, b.top + 8); return !p.hidden && b.top >= 0 && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight && mid !== null && mid.closest('#picker') !== null; })()`), await js(`JSON.stringify(document.getElementById('picker').getBoundingClientRect())`));
  await shot('fixture-21-pinned-phone-menu', false);
  await js(`document.body.click()`);
  await scroll(0);
  await js(`(() => { const hs = [...document.querySelectorAll('.group-h')]; hs[hs.length - 1].focus(); })()`);
  await sleep(250);
  let phoneTabs = 0;
  while (phoneTabs < 12 && !(await js(`document.activeElement.matches('button.row')`))) {
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    phoneTabs++; await sleep(200);
  }
  check('390: Tab onto a row far down the list leaves it whole, below the pinned headline', await js(`(() => { const e = document.activeElement, b = e.getBoundingClientRect(); const h = document.getElementById('head').getBoundingClientRect(); return e.matches('button.row') && b.top >= h.bottom - 0.5 && b.bottom <= innerHeight + 0.5 && scrollY > 0; })()`), await js(`(() => { const e = document.activeElement, b = e.getBoundingClientRect(); return { what: e.className, top: Math.round(b.top), bottom: Math.round(b.bottom), bar: Math.round(document.getElementById('head').getBoundingClientRect().bottom), scrolled: Math.round(scrollY) }; })()`));

  // paper does not scroll
  await send('Emulation.setEmulatedMedia', { media: 'print' }); await sleep(200);
  check('print: nothing on the page is sticky', await js(`[...document.querySelectorAll('*')].every(e => getComputedStyle(e).position !== 'sticky')`), await js(`[...document.querySelectorAll('*')].filter(e => getComputedStyle(e).position === 'sticky').map(e => e.id || e.className)`));
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(150);
  await go('fixture', '?since=2025-12-01');

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
