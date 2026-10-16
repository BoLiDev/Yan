/*
 * yan serve — the page. Plain script, no build step.
 *
 * Three panes: the tasks on the left, one task's index in the middle (its
 * notes, its branch, its artifacts as a tree), and on the right whatever was
 * picked, shown as what it is. The route lives in the URL's hash, so back,
 * forward and a reload all land where they were.
 *
 * Text comes from /blob/<sha> on this origin. Images, pages, players and
 * downloads come from the files origin the index names, one port up, where
 * a page an agent wrote runs as itself and cannot reach this one.
 *
 * The server says when the vault moved through /api/events; the page then
 * reloads what it shows, and redraws the right pane only when what is in it
 * changed, so a page or a video playing there is not restarted every tick.
 */
'use strict';

// ── building blocks ─────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const STROKE = {
  latest: '<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M6.5 5h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  prev: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  overview: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  branch: '<circle cx="6" cy="6" r="2.25"/><circle cx="6" cy="18" r="2.25"/><circle cx="18" cy="6" r="2.25"/><path d="M6 8.25v7.5M18 8.25c0 4.5-4 5.5-9.5 7.5"/>',
  dark: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M4 18h5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
};
const STATES = {
  open: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#0b7285" stroke-width="1.5"/><path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="#0b7285"/>',
  done: '<circle cx="8" cy="8" r="7" fill="#1f7a3d"/><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  abandoned: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#66655f" stroke-width="1.5"/><path d="m4.2 11.8 7.6-7.6" stroke="#66655f" stroke-width="1.5"/>',
};

function svg(markup, size, viewBox, extra) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(extra || {})) s.setAttribute(k, v);
  s.innerHTML = markup;
  return s;
}
function icon(name, size = 16, width = 1.75) {
  return svg(STROKE[name], size, '0 0 24 24', { fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}
function stateIcon(state, size = 16) {
  const s = svg(STATES[state] || STATES.open, size, '0 0 16 16');
  s.style.flex = 'none';
  return s;
}

/** An element: `h('a', { class: 'row', href, onclick }, ...children)`. Text is always text, never markup. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
  return el;
}
function tool(name, label, onclick, opts = {}) {
  const b = h(opts.href ? 'a' : 'button', {
    type: opts.href ? null : 'button',
    class: 'tool' + (opts.small ? ' small' : ''),
    'aria-label': label,
    title: label,
    'aria-pressed': opts.pressed === undefined ? null : String(!!opts.pressed),
    disabled: opts.disabled ? true : null,
    href: opts.href || null,
    target: opts.href && opts.newTab !== false ? '_blank' : null,
    rel: opts.href ? 'noopener' : null,
    onclick,
  }, icon(name, opts.small ? 15 : 17));
  return b;
}
function seg(options, current, onpick, wide) {
  return h('div', { class: 'seg' + (wide ? ' wide' : ''), role: 'group' },
    options.map(([value, label]) => h('button', { type: 'button', 'aria-pressed': String(value === current), onclick: () => onpick(value) }, label)));
}

let toastTimer;
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ── words for times and sizes ───────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n) => String(n).padStart(2, '0');
const nowS = () => Math.floor(Date.now() / 1000);
const fromIso = (iso) => (iso ? Math.floor(new Date(iso).getTime() / 1000) || 0 : 0);

function dayOf(ts) {
  const d = new Date(ts * 1000);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${y}`;
}
function clock(ts, seconds) {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? ':' + pad(d.getSeconds()) : ''}`;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function when(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date();
  if (sameDay(d, today)) return `today ${clock(ts)}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (sameDay(d, y)) return `yesterday ${clock(ts)}`;
  return `${dayOf(ts)} ${clock(ts)}`;
}
function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  if (sameDay(d, today)) return 'Today';
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return `${WEEKDAYS[d.getDay()]}, ${dayOf(ts)}`;
}
function monthLabel(ts) {
  const d = new Date(ts * 1000);
  return MONTHS_LONG[d.getMonth()] + (d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`);
}
function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const short = (sha) => (sha || '').slice(0, 7);
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;

// ── what a file is ──────────────────────────────────────────────────────────

const EXT_KIND = {};
const kinds = {
  image: 'png jpg jpeg gif webp svg avif bmp ico',
  page: 'html htm',
  doc: 'md markdown txt pdf rst',
  code: 'js mjs cjs ts tsx jsx json jsonl css scss less py sh bash zsh ps1 bat rb go rs java kt swift c h cpp hpp cs yaml yml toml xml sql lua vue svelte diff patch log csv tsv ini env',
  media: 'mp3 wav ogg m4a flac aac mp4 webm mov m4v',
  font: 'woff woff2 ttf otf',
};
for (const [kind, list] of Object.entries(kinds)) for (const e of list.split(' ')) EXT_KIND[e] = kind;
const KIND_LABEL = { image: 'Images', page: 'Pages', doc: 'Docs', code: 'Code', media: 'Media', font: 'Fonts', other: 'Other' };
const KIND_ORDER = ['image', 'page', 'doc', 'code', 'media', 'font', 'other'];
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
const WRAPPED = new Set(['log', 'txt', 'md', 'markdown', 'jsonl', 'csv', 'tsv', '']);

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function ext(name) {
  const m = /\.([^./]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}
const kindOf = (name) => EXT_KIND[ext(name)] || 'other';
function badge(name) {
  const e = ext(name);
  return (e || 'file').slice(0, 4).toUpperCase();
}
/** How the right pane shows a file. */
function viewerOf(name) {
  const e = ext(name);
  const k = kindOf(name);
  if (k === 'image') return 'image';
  if (k === 'page') return 'page';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'pdf') return 'pdf';
  if (k === 'media') return VIDEO.has(e) ? 'video' : 'audio';
  if (k === 'font') return 'font';
  return 'text';
}

/**
 * The same screen taken another way: `stage1-1280.png` and `stage1-390.png`,
 * `home-light.png` and `home-dark.png`. Names that differ in one word, both
 * words a width or a look.
 */
const VARIANT = /^(\d{3,4}|desktop|mobile|phone|tablet|ipad|light|dark|wide|narrow|portrait|landscape)$/i;
function variantsOf(name, names) {
  const mine = name.split(/([-_.])/);
  const found = [];
  for (const other of names) {
    if (other === name) continue;
    const theirs = other.split(/([-_.])/);
    if (theirs.length !== mine.length) continue;
    let at = -1;
    let count = 0;
    for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) (count++, (at = i));
    if (count === 1 && VARIANT.test(mine[at]) && VARIANT.test(theirs[at])) found.push({ name: other, word: theirs[at] });
  }
  return found;
}

// ── state ───────────────────────────────────────────────────────────────────

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a private window keeps nothing, and the page works without it */
  }
}

const S = {
  index: null,
  byId: new Map(),
  version: -1,
  status: null,
  connected: true,
  pulling: false,
  filesOrigin: '',
  tasks: new Map(),
  branches: new Map(),
  texts: new Map(),
  route: { view: 'latest' },
  expanded: new Map(),
  filter: new Map(),
  visit: new Map(),
  problemBase: new Map(),
  logBase: new Map(),
  latestBase: null,
  last: new Map(),
  query: '',
  rightKey: '',
  rightToken: 0,
  page: { source: false, mdSource: false },
  prefs: Object.assign({ left: true, dark: false, layout: 'unified', width: 'fit', whole: false, wrap: {} }, load('yan.serve.prefs', {})),
  seen: load('yan.serve.seen', null),
};
const savePrefs = () => save('yan.serve.prefs', S.prefs);
const saveSeen = () => save('yan.serve.seen', S.seen);

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const vaultPath = (id, rel) => `tasks/${id}/artifacts/${rel}`;
const fileUrl = (path) => `${S.filesOrigin}/${enc(path)}`;
const shaUrl = (sha, name) => `${S.filesOrigin}/_sha/${sha}/${encodeURIComponent(name)}`;
const link = {
  task: (id) => `#/t/${id}`,
  log: (id) => `#/t/${id}/log`,
  file: (id, p) => `#/t/${id}/a/${enc(p)}`,
  folder: (id, p) => `#/t/${id}/a/${p ? enc(p) + '/' : ''}`,
  branch: (id, repo, tab, item) => `#/t/${id}/b/${repo}/${tab || 'changes'}${item ? '/' + enc(item) : ''}`,
  latest: (id, p) => (id ? `#/latest/${id}/${enc(p)}` : '#/latest'),
};

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  let parts;
  try {
    parts = raw.split('/').map(decodeURIComponent);
  } catch {
    parts = [];
  }
  if (parts[0] === 't' && parts[1]) {
    const id = parts[1];
    const rest = parts.slice(2);
    if (rest[0] === 'log') return { view: 'task', id, sub: 'log' };
    if (rest[0] === 'a') {
      const p = rest.slice(1).join('/');
      if (p === '' || raw.endsWith('/')) return { view: 'task', id, sub: 'folder', path: p.replace(/\/$/, '') };
      return { view: 'task', id, sub: 'file', path: p };
    }
    if (rest[0] === 'b') return { view: 'task', id, sub: 'branch', repo: Number(rest[1]) || 0, tab: rest[2] || 'changes', item: rest.slice(3).join('/') };
    return { view: 'task', id, sub: 'overview' };
  }
  if (parts[0] === 'latest' && parts[1]) return { view: 'latest', id: parts[1], path: parts.slice(2).join('/') };
  return { view: 'latest' };
}

// ── what is new since the last look ─────────────────────────────────────────
//
// Kept in this browser only: one person, one machine. A task's mark is the
// newest commit time seen in it, so what another machine pushed while this
// one was away counts as new when it arrives.

function initSeen() {
  if (S.seen && S.seen.tasks) return;
  const newest = Math.max(0, ...S.index.tasks.map((t) => t.touched));
  S.seen = { init: newest, latest: newest, tasks: {}, problems: {}, logs: {} };
  saveSeen();
}
const seenAt = (id) => S.seen.tasks[id] ?? S.seen.init;
function newCount(t) {
  const base = seenAt(t.id);
  let n = 0;
  for (const a of t.added) {
    if (a <= base) break;
    n++;
  }
  return n;
}
function markTaskSeen(id) {
  const t = S.byId.get(id);
  if (!t) return;
  if (!S.visit.has(id)) S.visit.set(id, seenAt(id));
  S.seen.tasks[id] = Math.max(seenAt(id), t.touched, t.added[0] || 0);
  saveSeen();
}
const isNew = (id, file) => file.added > (S.visit.get(id) ?? seenAt(id));
function latestUnseen() {
  return S.index ? S.index.latest.filter((p) => p.at > S.seen.latest).length : 0;
}
function markLatestSeen() {
  if (!S.index) return;
  if (S.latestBase === null) S.latestBase = S.seen.latest;
  S.seen.latest = Math.max(S.seen.latest, ...S.index.latest.map((p) => p.at));
  saveSeen();
}

// ── talking to the server ───────────────────────────────────────────────────

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function loadIndex() {
  const j = await getJSON('/api/index');
  S.index = j;
  S.byId = new Map(j.tasks.map((t) => [t.id, t]));
  S.version = j.status.version;
  S.status = j.status;
  S.filesOrigin = j.filesOrigin;
  initSeen();
}
async function loadTask(id, force) {
  const have = S.tasks.get(id);
  if (have && have.version === S.version && !force) return have.detail;
  const detail = await getJSON(`/api/task/${encodeURIComponent(id)}`);
  S.tasks.set(id, { detail, version: S.version });
  return detail;
}
const detailOf = (id) => S.tasks.get(id)?.detail;
async function loadBranch(id, repo, fresh) {
  const v = await getJSON(`/api/branch?task=${encodeURIComponent(id)}&repo=${repo}${fresh ? '&fresh=1' : ''}`);
  S.branches.set(`${id}:${repo}`, v);
  return v;
}
const branchOf = (id, repo) => S.branches.get(`${id}:${repo}`);
/** A blob as text, once per sha: the same sha is the same bytes forever. */
function textOf(url) {
  if (!S.texts.has(url)) {
    S.texts.set(url, fetch(url).then(async (r) => {
      if (!r.ok) throw new Error((await r.text()) || r.statusText);
      return r.text();
    }));
    S.texts.get(url).catch(() => S.texts.delete(url));
  }
  return S.texts.get(url);
}
const looksBinary = (text) => text.slice(0, 8000).includes('\u0000');

async function pullNow() {
  if (S.pulling) return;
  S.pulling = true;
  renderSync();
  try {
    const r = await fetch('/api/pull', { method: 'POST' });
    if (r.ok) await onStatus(await r.json());
    // A pull asked for by hand fetches the branch being looked at too, and waits for it.
    const at = S.route;
    if (at.view === 'task' && at.sub === 'branch' && S.byId.has(at.id)) {
      await loadBranch(at.id, at.repo, true);
      render();
    }
  } catch {
    S.connected = false;
  }
  S.pulling = false;
  renderSync();
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => {
    const wasDown = !S.connected;
    S.connected = true;
    const st = JSON.parse(e.data);
    if (wasDown) S.version = -1;
    void onStatus(st);
  });
  es.onerror = () => {
    S.connected = false;
    renderSync();
  };
}

let refreshing = null;
async function onStatus(st) {
  S.status = st;
  renderSync();
  if (st.version !== S.version) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        await loadIndex();
        const r = S.route;
        if (r.id && S.byId.has(r.id)) {
          await loadTask(r.id, true);
          if (r.view === 'task') markTaskSeen(r.id);
        }
        if (r.view === 'latest') markLatestSeen();
        render();
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  const r = S.route;
  if (r.view === 'task' && r.sub === 'branch' && S.byId.has(r.id)) {
    const before = branchOf(r.id, r.repo);
    try {
      const after = await loadBranch(r.id, r.repo);
      if (!before || before.head !== after.head || before.base !== after.base || before.fetchedAt !== after.fetchedAt) render();
    } catch {
      /* the next tick tries again */
    }
  }
  return undefined;
}

// ── panes ───────────────────────────────────────────────────────────────────

const app = document.getElementById('app');
const L = document.getElementById('left');
const M = document.getElementById('middle');
const R = document.getElementById('right');

function render() {
  renderLeft();
  renderMiddle();
  renderRight();
}

// ── left: the vault and its tasks ───────────────────────────────────────────

const left = {};
function buildLeft() {
  left.vault = h('span', { class: 'vault-chip' });
  left.sync = h('button', { type: 'button', class: 'sync', 'aria-label': 'Pull now', onclick: pullNow });
  left.find = h('input', {
    type: 'search',
    placeholder: 'Find a task',
    'aria-label': 'Find a task',
    oninput: () => {
      S.query = left.find.value;
      renderLeft();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        const first = left.list.querySelector('a.row');
        if (first) location.hash = first.getAttribute('href');
      } else if (e.key === 'Escape') {
        left.find.value = '';
        S.query = '';
        renderLeft();
        left.find.blur();
      }
    },
  });
  left.latest = h('div');
  left.list = h('div', { class: 'group', style: { gap: '12px' } });
  left.scroll = h('div', { class: 'pane-scroll' }, left.list);
  const top = h('div', { class: 'pane-top' },
    h('div', { class: 'brand' }, h('b', null, 'yan'), left.vault, h('span', { class: 'grow' }), tool('panel', 'Hide the task list', () => setLeft(false), { small: true })),
    left.sync,
    h('label', { class: 'find' }, icon('search', 15), left.find),
    left.latest);
  edgeOnScroll(top, left.scroll);
  L.replaceChildren(top, left.scroll);
  const rail = document.getElementById('rail-open');
  rail.append(icon('panel', 17));
  rail.addEventListener('click', () => setLeft(true));
}
function setLeft(shown) {
  S.prefs.left = shown;
  savePrefs();
  app.classList.toggle('left-hidden', !shown);
}

function renderSync() {
  const st = S.status;
  let cls = '';
  let head = 'Up to date';
  let sub = '';
  if (!S.connected) {
    cls = 'down';
    head = 'yan serve stopped';
    sub = "start it again with 'yan serve'";
  } else if (S.pulling) {
    cls = 'busy';
    head = 'Pulling…';
    sub = st?.checkedAt ? `checked ${clock(st.checkedAt, true)}` : '';
  } else if (st && st.local) {
    head = 'Local vault';
    sub = 'no origin to pull from';
  } else if (st && !st.ok) {
    cls = 'warn';
    head = "Can't reach origin";
    sub = st.pulledAt ? `last pulled ${clock(st.pulledAt)}` : 'not pulled yet';
  } else if (st) {
    sub = `checked ${clock(st.checkedAt, true)}`;
  }
  left.sync.className = 'sync' + (cls ? ' ' + cls : '');
  const every = st ? `Pulls every ${st.everyS} s by itself. ` : '';
  left.sync.title = (st?.error ? `${st.error}\n` : '') + every + 'Click to pull now.';
  left.sync.replaceChildren(h('span', { class: 'light' }), h('span', { class: 'words' }, h('b', null, head), h('span', null, sub)), icon('refresh', 16));
}

function taskRow(t, opts = {}) {
  const r = S.route;
  const on = r.view === 'task' && r.id === t.id;
  const n = on ? 0 : newCount(t);
  return h('a', { class: 'row' + (on ? ' on' : ''), href: S.last.get(t.id) || link.task(t.id), title: t.title || t.id },
    stateIcon(t.state),
    h('span', { class: 'grow' }, t.title || t.id),
    n > 0 ? h('span', { class: 'badge', title: `${plural(n, 'new file')}` }, n) : null,
    opts.hideId ? null : h('span', { class: 'aside' }, t.id));
}

function renderLeft() {
  if (!S.index) return;
  left.vault.textContent = S.index.vault.name;
  left.vault.title = S.index.vault.dir;
  renderSync();
  const top = left.scroll.scrollTop;
  const tasks = S.index.tasks;
  const q = S.query.trim().toLowerCase();
  const parts = [];

  if (q) {
    const hits = tasks.filter((t) => t.id.toLowerCase().includes(q) || (t.title || '').toLowerCase().includes(q));
    hits.sort((a, b) => b.touched - a.touched);
    parts.push(h('div', { class: 'group' }, h('div', { class: 'label' }, hits.length ? plural(hits.length, 'task') : 'No task matches'), hits.map((t) => taskRow(t))));
  } else {
    const open = tasks.filter((t) => t.state === 'open').sort((a, b) => b.touched - a.touched);
    parts.push(h('div', { class: 'group' }, h('div', { class: 'label' }, 'In progress'), open.length ? open.map((t) => taskRow(t)) : h('div', { class: 'sublabel' }, 'Nothing open')));

    const closed = tasks.filter((t) => t.state !== 'open').sort((a, b) => (fromIso(b.closedAt) || b.touched) - (fromIso(a.closedAt) || a.touched));
    const rows = [];
    let month = '';
    for (const t of closed) {
      const m = monthLabel(fromIso(t.closedAt) || t.touched);
      if (m !== month) rows.push(h('div', { class: 'sublabel' }, (month = m)));
      rows.push(taskRow(t));
    }
    if (rows.length) parts.push(h('div', { class: 'group' }, h('div', { class: 'label' }, 'Done'), rows));
  }
  const unseen = latestUnseen();
  const onLatest = S.route.view === 'latest';
  left.latest.replaceChildren(h('a', { class: 'row' + (onLatest ? ' on' : ''), href: '#/latest', style: { fontWeight: 700 } },
    icon('latest', 17), h('span', { class: 'grow' }, 'Latest'), unseen > 0 && !onLatest ? h('span', { class: 'badge solid' }, unseen) : null));
  left.list.replaceChildren(...parts);
  left.scroll.scrollTop = top;
}

/** A line under a pane's fixed top, once what is below it has scrolled under. */
function edgeOnScroll(top, scroller) {
  const mark = () => top.classList.toggle('edge', scroller.scrollTop > 0);
  scroller.addEventListener('scroll', mark, { passive: true });
  mark();
}

/** A pane: what stays at its top, what scrolls below that, and what stays at its foot. */
function pane(topKids, bodyKids, footKids) {
  const top = h('div', { class: 'pane-top' }, topKids);
  const body = h('div', { class: 'pane-scroll' }, bodyKids);
  edgeOnScroll(top, body);
  return [top, body, footKids ? h('div', { class: 'pane-foot' }, footKids) : null].filter(Boolean);
}

// ── middle ──────────────────────────────────────────────────────────────────

const middleScroll = new Map();
let middleFor = '';

function renderMiddle() {
  const r = S.route;
  const key = r.view === 'latest' ? 'latest' : r.id;
  const before = M.querySelector('.pane-scroll');
  if (middleFor && before) middleScroll.set(middleFor, before.scrollTop);
  if (!S.index) return;
  if (r.view === 'latest') renderFeed();
  else renderTaskIndex(r);
  const scroller = M.querySelector('.pane-scroll');
  if (scroller) {
    scroller.scrollTop = middleScroll.get(key) || 0;
    scroller.dispatchEvent(new Event('scroll'));
  }
  middleFor = key;
  const on = scroller?.querySelector('.row.on, .commit-line.on');
  if (on) {
    const a = on.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    if (a.top < b.top || a.bottom > b.bottom) on.scrollIntoView({ block: 'center' });
  }
}

function taskSub(t) {
  const bits = [t.id];
  if (t.state === 'open') bits.push(t.createdAt ? `started ${dayOf(fromIso(t.createdAt))}` : 'in progress');
  else if (t.state === 'done') bits.push(t.closedAt ? `done ${dayOf(fromIso(t.closedAt))}` : 'done');
  else bits.push(t.closedAt ? `dropped ${dayOf(fromIso(t.closedAt))}` : 'dropped');
  const repos = t.repos.map((x) => x.name).join(', ');
  if (repos) bits.push(repos);
  return bits.join(' · ');
}

function renderTaskIndex(r) {
  const t = S.byId.get(r.id);
  if (!t) {
    M.replaceChildren(h('div', { class: 'empty' }, h('h2', null, `No ${r.id} here`), `The vault ${S.index.vault.name} has no task called ${r.id}.`));
    return;
  }
  const d = detailOf(r.id);
  const nav = [];
  const total = t.deliverables.done + t.deliverables.todo + t.deliverables.abandoned;
  nav.push(h('a', { class: 'row' + (r.sub === 'overview' ? ' on' : ''), href: link.task(t.id) },
    icon('overview', 16), h('span', { class: 'grow' }, 'Overview'), h('span', { class: 'aside' }, total ? plural(total, 'deliverable') : 'problem')));
  const logCount = d?.log?.entries.length ?? 0;
  const logFresh = d?.log && logCount > (S.logBase.get(t.id) ?? S.seen.logs[t.id] ?? logCount);
  nav.push(h('a', { class: 'row' + (r.sub === 'log' ? ' on' : ''), href: link.log(t.id) },
    icon('log', 16), h('span', { class: 'grow' }, 'Log'), logFresh ? h('span', { class: 'dot', title: 'new entries' }) : null, h('span', { class: 'aside' }, d ? logCount : '')));
  t.repos.forEach((repo, i) => {
    if (!repo.branch) return;
    const on = r.sub === 'branch' && r.repo === i;
    nav.push(h('a', { class: 'row' + (on ? ' on' : ''), href: link.branch(t.id, i), title: `${repo.name} · ${repo.branch}` },
      icon('branch', 16),
      h('span', { class: 'grow' }, 'Branch ', h('span', { class: 'mono dim', style: { fontSize: '12px', fontWeight: 400 } }, repo.branch)),
      t.repos.length > 1 ? h('span', { class: 'aside' }, repo.name) : null));
  });

  const head = [
    h('div', { class: 'task-head' },
      h('div', { class: 't' }, stateIcon(t.state, 18), h('h1', null, t.title || t.id)),
      h('div', { class: 'sub' }, taskSub(t))),
    h('div', { class: 'nav' }, nav),
  ];
  // An open branch takes the part that scrolls, and the artifacts wait at the foot.
  const part = r.sub === 'branch' ? branchPanel(t, r) : artifactsPanel(t, d, r);
  const foot = r.sub === 'branch' && d
    ? h('a', { class: 'row', href: link.folder(t.id, '') }, h('span', { class: 'folder-icon dim' }, icon('folder', 15)), h('span', { class: 'grow' }, 'Artifacts'), h('span', { class: 'aside' }, d.files.length))
    : null;
  M.replaceChildren(...pane([...head, part.top], part.body, foot));
}

/** Folders open by default when there are few files; the ones holding what is shown always are. */
function expandedFor(id, files) {
  let set = S.expanded.get(id);
  if (!set) {
    set = new Set();
    if (files.length <= 40) for (const f of files) for (let p = dirName(f.path); p; p = dirName(p)) set.add(p);
    S.expanded.set(id, set);
  }
  return set;
}
function openTo(id, path) {
  const set = S.expanded.get(id);
  if (!set) return;
  for (let p = path; p; p = dirName(p)) set.add(p);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) node.dirs.set(parts[i], (next = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], count: 0 }));
      node = next;
      node.count++;
    }
    node.files.push(f);
  }
  return root;
}
const sortedDirs = (node) => [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name));
const sortedFiles = (node) => [...node.files].sort((a, b) => collator.compare(baseName(a.path), baseName(b.path)));
/** Every file in tree order: what prev and next walk. */
function treeOrder(node, out = []) {
  for (const d of sortedDirs(node)) treeOrder(d, out);
  for (const f of sortedFiles(node)) out.push(f);
  return out;
}

function fileThumb(f, name) {
  if (kindOf(name) === 'image') return h('img', { class: 'thumb', src: shaUrl(f.sha, name), alt: '', loading: 'lazy', decoding: 'async' });
  return h('span', { class: 'kind' }, badge(name));
}

function treeRows(node, depth, ctx, out) {
  for (const dir of sortedDirs(node)) {
    const open = ctx.open.has(dir.path);
    const current = ctx.folder === dir.path;
    const chev = h('span', {
      class: 'chev', role: 'button', 'aria-label': open ? 'Close the folder' : 'Open the folder',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (open) ctx.open.delete(dir.path);
        else ctx.open.add(dir.path);
        renderMiddle();
      },
    }, icon('chev', 12, 2.25));
    out.push(h('a', {
      class: 'row folder' + (open ? ' open' : '') + (current ? ' on' : ''),
      href: ctx.folderHref(dir.path),
      style: { paddingLeft: `${10 + depth * 16}px` },
      role: 'treeitem',
      'aria-expanded': String(open),
      onclick: () => {
        if (open && current) {
          ctx.open.delete(dir.path);
          renderMiddle();
        } else ctx.open.add(dir.path);
      },
    }, chev, h('span', { class: 'folder-icon' }, icon('folder', 15)), h('span', { class: 'grow' }, dir.name), h('span', { class: 'aside' }, dir.count)));
    if (open) treeRows(dir, depth + 1, ctx, out);
  }
  for (const f of sortedFiles(node)) {
    const name = baseName(f.path);
    const on = ctx.file === f.path;
    out.push(h('a', {
      class: 'row' + (on ? ' on' : ''),
      href: ctx.fileHref(f.path),
      style: { paddingLeft: `${32 + depth * 16}px` },
      role: 'treeitem',
      'aria-selected': String(on),
      title: f.path,
    },
    ctx.thumbs === false ? h('span', { class: 'kind' }, badge(name)) : fileThumb(f, name),
    h('span', { class: 'grow', style: { fontWeight: on ? 700 : 400 } }, name),
    ctx.isNew && ctx.isNew(f) ? h('span', { class: 'dot', title: 'new since your last look' }) : null,
    ctx.extra ? ctx.extra(f) : null));
  }
}

function kindCounts(files) {
  const counts = {};
  for (const f of files) {
    const k = kindOf(f.path);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}
const filterOf = (id) => S.filter.get(id) || 'all';
function shownFiles(id, d) {
  const k = filterOf(id);
  return k === 'all' ? d.files : d.files.filter((f) => kindOf(f.path) === k);
}

function artifactsPanel(t, d, r) {
  if (!d) return { top: h('div', { class: 'section-head' }, h('b', null, 'Artifacts'), h('span', null, 'loading…')), body: [] };
  const counts = kindCounts(d.files);
  const kindsHere = KIND_ORDER.filter((k) => counts[k]);
  const filter = filterOf(t.id);
  const chips = kindsHere.length > 1
    ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Kind' },
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === 'all'), onclick: () => setFilter(t.id, 'all') }, 'All'),
      kindsHere.map((k) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === k), onclick: () => setFilter(t.id, k) }, `${KIND_LABEL[k]} ${counts[k]}`)))
    : null;

  const files = shownFiles(t.id, d);
  const open = expandedFor(t.id, d.files);
  const out = [];
  treeRows(buildTree(files), 0, {
    open,
    file: r.sub === 'file' ? r.path : null,
    folder: r.sub === 'folder' ? r.path : null,
    fileHref: (p) => link.file(t.id, p),
    folderHref: (p) => link.folder(t.id, p),
    isNew: (f) => isNew(t.id, f),
  }, out);

  const hidden = d.hidden.length
    ? h('div', { class: 'hidden-note' }, `Not shown: ${d.hidden.map((x) => `${x.name} (${x.count})`).join(', ')}`)
    : null;
  return {
    top: h('div', { class: 'stack' },
      h('div', { class: 'section-head' },
        h('b', null, 'Artifacts'), h('span', null, d.files.length), h('span', { class: 'grow' }),
        d.files.length ? tool('grid', 'See them all as a grid', null, { small: true, href: link.folder(t.id, ''), newTab: false }) : null),
      chips),
    body: [d.files.length ? h('div', { class: 'tree', role: 'tree', 'aria-label': 'Artifacts' }, out) : h('div', { class: 'sublabel' }, 'No artifacts yet.'), hidden],
  };
}
function setFilter(id, k) {
  S.filter.set(id, k);
  renderMiddle();
  S.rightKey = '';
  renderRight();
}

// ── middle: a branch ────────────────────────────────────────────────────────

function branchPanel(t, r) {
  const repo = t.repos[r.repo];
  const b = branchOf(t.id, r.repo);
  if (!repo || !repo.branch) return { top: h('div', { class: 'sublabel' }, 'This task keeps no branch here.'), body: [] };
  if (!b) return { top: h('div', { class: 'branch-card' }, h('div', { class: 'top' }, icon('branch', 16), h('b', null, repo.name), h('span', { class: 'grow mono dim' }, repo.branch)), h('div', { class: 'facts' }, 'reading the branch…')), body: [] };

  const facts = [];
  if (b.merged) {
    const words = b.merged.pr ? `merged · PR #${b.merged.pr}` : 'merged';
    facts.push(b.links.pr ? h('a', { class: 'merged', href: b.links.pr, target: '_blank', rel: 'noopener' }, words) : h('span', { class: 'merged' }, words));
  } else if (!b.missing) {
    facts.push(h('span', null, `${b.ahead} ahead${b.behind ? ` · ${b.behind} behind` : ''} ${b.target}`));
  }
  if (!b.missing) facts.push(h('span', null, plural(b.commits.length, 'commit')));
  if (b.fetchedAt) facts.push(h('span', { title: b.fetchError || '' }, `${b.fetchError ? "couldn't fetch · " : 'fetched '}${clock(b.fetchedAt)}`));
  const card = h('div', { class: 'branch-card' },
    h('div', { class: 'top' }, h('span', { style: { color: 'var(--accent)', display: 'flex' } }, icon('branch', 16)), h('b', null, b.repo),
      h('span', { class: 'grow mono', style: { fontSize: '12.5px', color: 'var(--ink-2)' }, title: b.branch }, b.branch),
      b.links.branch ? tool('external', 'Open the branch on GitHub', null, { small: true, href: b.links.branch }) : null),
    facts.length ? h('div', { class: 'facts' }, facts) : null,
    b.missing ? h('div', { class: 'facts error' }, b.missing) : h('div', { class: 'from', title: b.clone }, `kept by yan branch · read from ${b.clone}`));
  if (b.missing) return { top: card, body: [] };

  const tabs = seg([['changes', `Changes ${b.files.length}`], ['commits', `Commits ${b.commits.length}`], ['files', 'All files']], r.tab, (tab) => {
    location.hash = link.branch(t.id, r.repo, tab);
  }, true);
  const list = [];
  if (r.tab === 'commits') {
    for (const c of b.commits) {
      const on = (r.item || b.commits[0]?.sha) === c.sha;
      list.push(h('a', { class: 'commit-line' + (on ? ' on' : ''), href: link.branch(t.id, r.repo, 'commits', c.sha) },
        h('span', { class: 'mono' }, short(c.sha)), h('span', { class: 'grow' }, c.subject), h('span', { class: 'aside' }, dayOf(c.at))));
    }
  } else if (r.tab === 'files') {
    const tree = S.branchTrees.get(b.head);
    if (!tree) {
      list.push(h('div', { class: 'sublabel' }, 'reading the files…'));
      void loadBranchTree(t.id, r.repo, b.head).then(() => renderMiddle());
    } else {
      const key = `${t.id}:${r.repo}:files`;
      if (!S.expanded.has(key)) S.expanded.set(key, new Set());
      if (r.item) for (let p = dirName(r.item); p; p = dirName(p)) S.expanded.get(key).add(p);
      treeRows(buildTree(tree), 0, {
        open: S.expanded.get(key),
        file: r.item || null,
        folder: null,
        thumbs: false,
        fileHref: (p) => link.branch(t.id, r.repo, 'files', p),
        folderHref: () => location.hash,
      }, list);
    }
  } else {
    const prefix = commonDir(b.files.map((f) => f.path));
    if (prefix) list.push(h('div', { class: 'prefix' }, prefix));
    const cur = r.item || b.files[0]?.path;
    for (const f of b.files) {
      const rest = f.path.slice(prefix.length);
      const on = f.path === cur;
      list.push(h('a', { class: 'row' + (on ? ' on' : ''), href: link.branch(t.id, r.repo, 'changes', f.path), title: f.from ? `${f.from} → ${f.path}` : f.path, style: { fontSize: '13.5px', padding: '5px 10px', gap: '8px' } },
        h('span', { class: `status-letter ${f.status}`, title: { A: 'added', D: 'deleted', R: 'renamed', M: 'changed', C: 'copied', T: 'type changed' }[f.status] || '' }, f.status === 'M' ? '' : f.status),
        h('span', { class: 'grow' }, h('span', { class: 'dim', style: { fontWeight: 400 } }, dirName(rest) ? dirName(rest) + '/' : ''), baseName(rest)),
        f.add === null ? h('span', { class: 'aside' }, 'binary') : [h('span', { class: 'plus' }, f.add ? `+${f.add}` : ''), h('span', { class: 'minus' }, f.del ? `−${f.del}` : '')]));
    }
    if (!b.files.length) list.push(h('div', { class: 'sublabel' }, `No changes against ${b.target}.`));
  }
  return { top: h('div', { class: 'stack' }, card, tabs), body: h('div', { class: 'tree' }, list) };
}
function commonDir(paths) {
  if (paths.length < 2) return paths.length ? dirName(paths[0]) + (dirName(paths[0]) ? '/' : '') : '';
  let prefix = paths[0];
  for (const p of paths) while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix.slice(0, prefix.lastIndexOf('/') + 1);
}
S.branchTrees = new Map();
async function loadBranchTree(id, repo, head) {
  if (S.branchTrees.has(head)) return;
  const files = await getJSON(`/api/branch/tree?task=${encodeURIComponent(id)}&repo=${repo}&head=${head}`);
  S.branchTrees.set(head, files);
}

// ── middle: Latest ──────────────────────────────────────────────────────────

function feedFiles() {
  const out = [];
  for (const p of S.index.latest) for (const f of p.files) out.push({ task: p.task, path: f.path, sha: f.sha, status: f.status, at: p.at });
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.task}/${f.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function renderFeed() {
  const r = S.route;
  const base = S.latestBase ?? S.seen.latest;
  const heading = h('div', { class: 'section-head', style: { padding: '0 10px' } },
    h('h1', { style: { margin: 0, fontSize: '19px', lineHeight: '26px' } }, 'Latest'), h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'tool text', style: { height: '28px', color: 'var(--accent)', fontSize: '12.5px' }, onclick: markAllSeen }, 'Mark all seen'));
  const parts = [];
  if (!S.index.latest.length) parts.push(h('div', { class: 'sublabel' }, 'Nothing has arrived in any task’s artifacts yet.'));
  let day = '';
  let group = null;
  const shownOnce = new Set();
  for (const p of S.index.latest) {
    const label = dayLabel(p.at);
    if (label !== day) {
      day = label;
      group = h('div', { class: 'group', style: { gap: '2px' } }, h('div', { class: 'feed-day' }, label));
      parts.push(group);
    }
    const t = S.byId.get(p.task);
    const rows = [];
    for (const f of p.files) {
      const k = `${p.task}/${f.path}`;
      const on = r.id === p.task && r.path === f.path && !shownOnce.has('on');
      if (on) shownOnce.add('on');
      const name = baseName(f.path);
      rows.push(h('a', { class: 'row' + (on ? ' on' : ''), href: link.latest(p.task, f.path), title: k },
        fileThumb(f, name),
        h('span', { class: 'grow', style: { fontWeight: on ? 700 : 400 } }, h('span', { class: 'dim' }, dirName(f.path) ? dirName(f.path) + '/' : ''), name),
        f.status === 'A' ? h('span', { class: 'tag new' }, 'added') : h('span', { class: 'tag changed' }, 'changed')));
    }
    group.append(h('div', { class: 'push' },
      h('div', { class: 'push-head' },
        p.at > base ? h('span', { class: 'dot', title: 'new since your last look' }) : null,
        h('b', null, clock(p.at)),
        h('a', { href: link.task(p.task) }, t?.title || p.task),
        h('span', { class: 'aside' }, p.task)),
      rows));
  }
  M.replaceChildren(...pane([heading], parts));
}
function markAllSeen() {
  for (const t of S.index.tasks) {
    S.seen.tasks[t.id] = Math.max(seenAt(t.id), t.touched, t.added[0] || 0);
    S.visit.delete(t.id);
  }
  S.seen.latest = Math.max(S.seen.latest, ...S.index.latest.map((p) => p.at));
  S.latestBase = S.seen.latest;
  saveSeen();
  render();
}

// ── right ───────────────────────────────────────────────────────────────────

function bar(titleKids, meta, tools) {
  return h('div', { class: 'bar' },
    h('div', { class: 'title' }, h('span', { class: 'name' }, titleKids), h('span', { class: 'meta' }, meta || '')),
    tools);
}
function crumb(path) {
  const dir = dirName(path);
  return [dir ? h('span', { class: 'dir' }, dir + ' / ') : null, baseName(path)];
}
function emptyRight(title, words) {
  R.replaceChildren(h('div', { class: 'empty' }, h('h2', null, title), words || ''));
}

function rightKey() {
  const r = S.route;
  const base = JSON.stringify(r);
  if (!S.index) return 'none';
  if (r.view === 'task') {
    const d = detailOf(r.id);
    if (r.sub === 'file') {
      const f = d?.files.find((x) => x.path === r.path);
      return `${base}|${f?.sha}|${filterOf(r.id)}|${S.prefs.dark}|${S.prefs.width}|${S.page.source}|${S.page.mdSource}|${JSON.stringify(S.prefs.wrap)}`;
    }
    if (r.sub === 'branch') {
      const b = branchOf(r.id, r.repo);
      return `${base}|${b?.head}|${b?.base}|${b?.missing}|${S.prefs.layout}|${S.prefs.whole}|${S.branchTrees.has(b?.head)}|${S.prefs.dark}`;
    }
    return `${base}|${S.version}|${d ? 'd' : '-'}|${filterOf(r.id)}`;
  }
  if (r.id) {
    const d = detailOf(r.id);
    const f = d?.files.find((x) => x.path === r.path);
    return `${base}|${f?.sha}|${S.prefs.dark}|${S.prefs.width}|${S.page.source}|${S.page.mdSource}|${JSON.stringify(S.prefs.wrap)}`;
  }
  return `${base}|${S.version}`;
}

function renderRight(force) {
  const key = rightKey();
  if (!force && key === S.rightKey) return;
  S.rightKey = key;
  const token = ++S.rightToken;
  const r = S.route;
  if (!S.index) return;
  if (r.view === 'latest') {
    if (!r.id) return latestGallery();
    const d = detailOf(r.id);
    if (!d) return emptyRight('Loading…');
    const file = d.files.find((f) => f.path === r.path);
    if (!file) return emptyRight('Not there any more', `${r.path} is no longer in ${r.id}'s artifacts.`);
    const list = feedFiles();
    const at = list.findIndex((f) => f.task === r.id && f.path === r.path);
    return viewFile({
      task: r.id, file, token,
      prev: at > 0 ? link.latest(list[at - 1].task, list[at - 1].path) : null,
      next: at >= 0 && at < list.length - 1 ? link.latest(list[at + 1].task, list[at + 1].path) : null,
      pos: at + 1, total: list.length,
      folderFiles: d.files.filter((f) => dirName(f.path) === dirName(file.path)),
      fileHref: (p) => link.latest(r.id, p),
      taskTitle: S.byId.get(r.id)?.title,
    });
  }
  const t = S.byId.get(r.id);
  if (!t) return emptyRight('No such task', `There is no ${r.id} in this vault.`);
  const d = detailOf(r.id);
  if (!d) return emptyRight('Loading…');
  if (r.sub === 'overview') return viewOverview(t, d, token);
  if (r.sub === 'log') return viewLog(t, d);
  if (r.sub === 'folder') return viewFolder(t, d, r.path);
  if (r.sub === 'branch') return viewBranch(t, r, token);
  const file = d.files.find((f) => f.path === r.path);
  if (!file) return emptyRight('Not there any more', `${r.path} is not in ${t.id}'s artifacts at the commit being shown.`);
  const shown = shownFiles(t.id, d);
  const pool = shown.some((f) => f.path === file.path) ? shown : d.files;
  const siblings = treeOrder(buildTree(pool.filter((f) => dirName(f.path) === dirName(file.path))));
  const at = siblings.findIndex((f) => f.path === file.path);
  viewFile({
    task: t.id, file, token,
    prev: at > 0 ? link.file(t.id, siblings[at - 1].path) : null,
    next: at < siblings.length - 1 ? link.file(t.id, siblings[at + 1].path) : null,
    pos: at + 1, total: siblings.length,
    folderFiles: d.files.filter((f) => dirName(f.path) === dirName(file.path)),
    fileHref: (p) => link.file(t.id, p),
  });
}

// ── right: one file ─────────────────────────────────────────────────────────

let keyNav = { prev: null, next: null };

function viewFile(ctx) {
  const { task, file, token } = ctx;
  const name = baseName(file.path);
  const path = vaultPath(task, file.path);
  const viewer = viewerOf(name);
  keyNav = { prev: ctx.prev, next: ctx.next };

  const meta = h('span', null, [KIND_LABEL[kindOf(name)].replace(/s$/, ''), bytes(file.size)].join(' · '));
  const tools = [];
  tools.push(h('div', { class: 'group-tools' },
    tool('prev', 'Previous file (←)', null, { href: ctx.prev || null, newTab: false, disabled: !ctx.prev }),
    h('span', { class: 'counter' }, ctx.total ? `${ctx.pos} / ${ctx.total}` : ''),
    tool('next', 'Next file (→)', null, { href: ctx.next || null, newTab: false, disabled: !ctx.next })));
  tools.push(h('span', { class: 'sep' }));
  const extra = h('div', { class: 'group-tools' });
  tools.push(extra);
  extra.append(
    tool('external', 'Open in a new tab', null, { href: fileUrl(path) }),
    tool('download', 'Download', null, { href: fileUrl(path) + '?download', newTab: false }));

  const stage = h('div', { class: 'stage' });
  const body = [];
  const foot = h('div', { class: 'foot' },
    file.added ? h('span', { title: file.changed !== file.added ? `changed ${when(file.changed)}` : '' }, `Added ${when(file.added)}`) : null,
    file.commit ? h('span', { class: 'mono', style: { fontSize: '12px' }, title: file.commit }, short(file.commit)) : null,
    h('button', { type: 'button', class: 'copy', title: 'Copy the path on this machine', onclick: () => copyPath(`${S.index.vault.dir}/${path}`) }, path, icon('copy', 13)),
    h('span', { class: 'grow' }));

  if (viewer === 'image') {
    stage.classList.toggle('dark', !!S.prefs.dark);
    extra.prepend(
      tool('dark', 'Dark backdrop', () => { S.prefs.dark = !S.prefs.dark; savePrefs(); renderRight(); }, { pressed: S.prefs.dark }),
      tool('full', 'Full screen (F)', () => stage.requestFullscreen?.(), {}));
    const img = h('img', { class: 'shot', src: shaUrl(file.sha, name), alt: name, decoding: 'async' });
    img.addEventListener('load', () => {
      if (img.naturalWidth) meta.textContent = `${ext(name).toUpperCase()} · ${img.naturalWidth} × ${img.naturalHeight} · ${bytes(file.size)}`;
    });
    stage.append(img,
      ctx.prev ? h('a', { class: 'hit prev', href: ctx.prev, 'aria-label': 'Previous file' }) : null,
      ctx.next ? h('a', { class: 'hit next', href: ctx.next, 'aria-label': 'Next file' }) : null);
    const names = ctx.folderFiles.map((f) => baseName(f.path));
    for (const v of variantsOf(name, names).slice(0, 2)) {
      const other = ctx.folderFiles.find((f) => baseName(f.path) === v.name);
      foot.append(h('a', { class: 'pair', href: ctx.fileHref(other.path) },
        h('img', { src: shaUrl(other.sha, v.name), alt: '' }),
        /^\d+$/.test(v.word) ? `Same screen at ${v.word}` : `Same screen, ${v.word}`));
    }
    body.push(stage);
  } else if (viewer === 'page') {
    extra.prepend(
      seg([['fit', 'Fit'], ['1280', '1280'], ['390', '390']], S.prefs.width, (w) => { S.prefs.width = w; S.page.source = false; savePrefs(); renderRight(); }),
      tool('log', S.page.source ? 'Show the page' : 'Show the source', () => { S.page.source = !S.page.source; renderRight(); }, { pressed: S.page.source }));
    if (S.page.source) {
      stage.classList.add('top');
      fillCode(stage, `/blob/${file.sha}`, name, token, meta, file.size);
    } else {
      stage.classList.add('page');
      stage.append(pageFrame(fileUrl(path), S.prefs.width));
      meta.textContent = `Page · ${bytes(file.size)} · runs on its own origin, away from yan`;
    }
    body.push(stage);
  } else if (viewer === 'markdown') {
    extra.prepend(seg([['doc', 'Rendered'], ['src', 'Source']], S.page.mdSource ? 'src' : 'doc', (v) => { S.page.mdSource = v === 'src'; renderRight(); }));
    if (S.page.mdSource) {
      stage.classList.add('top');
      fillCode(stage, `/blob/${file.sha}`, name, token, meta, file.size);
      body.push(stage);
    } else {
      const scroll = h('div', { class: 'scroll' }, h('div', { class: 'empty' }, 'Loading…'));
      body.push(scroll);
      textOf(`/blob/${file.sha}`).then((text) => {
        if (token !== S.rightToken) return;
        meta.textContent = `Markdown · ${plural(text.split('\n').length, 'line')} · ${bytes(file.size)}`;
        scroll.replaceChildren(markdownDoc(text, { task, dir: dirName(`artifacts/${file.path}`), outline: true }));
      }, (err) => scroll.replaceChildren(h('div', { class: 'empty error' }, String(err.message || err))));
    }
  } else if (viewer === 'text') {
    const e = ext(name);
    const wrap = S.prefs.wrap[e] ?? WRAPPED.has(e);
    extra.prepend(tool('wrap', wrap ? 'Stop wrapping lines' : 'Wrap long lines', () => { S.prefs.wrap[e] = !wrap; savePrefs(); renderRight(); }, { pressed: wrap }));
    stage.classList.add('top');
    fillCode(stage, `/blob/${file.sha}`, name, token, meta, file.size, wrap);
    body.push(stage);
  } else if (viewer === 'audio') {
    stage.append(h('div', { class: 'file-card' }, h('span', { class: 'big-kind' }, badge(name)), h('b', null, name), h('audio', { controls: true, preload: 'metadata', src: fileUrl(path) })));
    body.push(stage);
  } else if (viewer === 'video') {
    // As large as the pane lets it be, at its own shape, so no black bars
    // frame it; it sits at the top, on the page's own ground.
    stage.classList.add('video-stage');
    const video = h('video', { controls: true, preload: 'metadata', playsinline: true, src: fileUrl(path) });
    stage.append(video);
    const fit = () => {
      const w = video.videoWidth;
      const hgt = video.videoHeight;
      const style = getComputedStyle(stage);
      const room = (a, b) => parseFloat(style[a]) + parseFloat(style[b]);
      const availW = stage.clientWidth - room('paddingLeft', 'paddingRight');
      const availH = stage.clientHeight - room('paddingTop', 'paddingBottom');
      if (!w || !hgt || availW <= 0 || availH <= 0) return;
      const scale = Math.min(availW / w, availH / hgt);
      video.style.width = `${Math.floor(w * scale)}px`;
      video.style.height = `${Math.floor(hgt * scale)}px`;
    };
    video.addEventListener('loadedmetadata', () => {
      fit();
      const secs = Math.round(video.duration);
      const length = Number.isFinite(secs) ? `${Math.floor(secs / 60)}:${pad(secs % 60)}` : '';
      meta.textContent = ['Video', `${video.videoWidth} × ${video.videoHeight}`, length, bytes(file.size)].filter(Boolean).join(' · ');
    });
    new ResizeObserver(fit).observe(stage);
    body.push(stage);
  } else if (viewer === 'pdf') {
    stage.classList.add('page');
    stage.append(h('iframe', { src: fileUrl(path), title: name, style: { width: '100%', height: '100%', border: 0, borderRadius: '8px', background: '#fff' } }));
    body.push(stage);
  } else if (viewer === 'font') {
    stage.append(h('div', { class: 'empty' }, 'Loading the font…'));
    fontSample(stage, file, name, token);
    body.push(stage);
  }

  R.replaceChildren(bar([ctx.taskTitle ? h('span', { class: 'dir' }, `${ctx.taskTitle} · `) : null, crumb(file.path)], meta, tools), ...body, foot);
}

function copyPath(p) {
  const done = () => toast('Path copied');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(p).then(done, () => prompt('The path', p));
  else prompt('The path', p);
}

/** A page at a width: Fit fills the pane; 1280 is drawn at 1280 and scaled down to fit; 390 is a phone, at its size. */
function pageFrame(src, width) {
  const frame = h('iframe', { src, title: 'Page', sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads' });
  const wrap = h('div', { class: 'frame-wrap' }, frame);
  const fit = () => {
    const w = wrap.clientWidth;
    const hgt = wrap.clientHeight;
    if (!w || !hgt) return;
    if (width === 'fit') {
      Object.assign(frame.style, { width: `${w}px`, height: `${hgt}px`, transform: 'none' });
    } else {
      const target = Number(width);
      const scale = Math.min(1, w / target);
      Object.assign(frame.style, { width: `${target}px`, height: `${hgt / scale}px`, transform: `scale(${scale})`, marginRight: `${target * scale - target}px` });
    }
  };
  new ResizeObserver(fit).observe(wrap);
  return wrap;
}

function fillCode(stage, url, name, token, meta, size, wrap) {
  stage.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
  textOf(url).then((text) => {
    if (token !== S.rightToken) return;
    if (looksBinary(text)) {
      stage.classList.remove('top');
      stage.replaceChildren(binaryCard(name, url, size));
      return;
    }
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (meta) meta.textContent = `${KIND_LABEL[kindOf(name)].replace(/s$/, '')} · ${plural(lines.length, 'line')}${size != null ? ` · ${bytes(size)}` : ''}`;
    stage.replaceChildren(codeView(lines, wrap ?? WRAPPED.has(ext(name))));
  }, (err) => stage.replaceChildren(h('div', { class: 'empty error' }, String(err.message || err))));
}

function codeView(lines, wrap) {
  const box = h('div', { class: 'code' + (wrap ? ' wrap' : '') });
  const LIMIT = 4000;
  const add = (from, to) => {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.append(h('div', { class: 'ln' }, h('span', { class: 'n' }, i + 1), h('span', { class: 't' }, lines[i] || ' ')));
    return frag;
  };
  box.append(add(0, Math.min(LIMIT, lines.length)));
  if (lines.length > LIMIT) {
    const more = h('div', { class: 'more' }, h('button', { type: 'button', class: 'button quiet', onclick: () => { more.remove(); box.append(add(LIMIT, lines.length)); } }, `Show the other ${plural(lines.length - LIMIT, 'line')}`));
    box.append(more);
  }
  return box;
}

function binaryCard(name, url, size) {
  return h('div', { class: 'file-card' }, h('span', { class: 'big-kind' }, badge(name)), h('b', null, name),
    h('span', { class: 'dim' }, `Not text${size != null ? ` · ${bytes(size)}` : ''} — open or download it.`));
}

function fontSample(stage, file, name, token) {
  fetch(`/blob/${file.sha}`).then((r) => r.arrayBuffer()).then(async (buf) => {
    const family = `yan-preview-${file.sha.slice(0, 12)}`;
    const face = new FontFace(family, buf);
    await face.load();
    document.fonts.add(face);
    if (token !== S.rightToken) return;
    const sample = (px, text) => h('div', { style: { fontFamily: `"${family}"`, fontSize: `${px}px`, lineHeight: 1.35 } }, text);
    stage.replaceChildren(h('div', { class: 'font-sample' },
      h('span', { class: 'dim', style: { fontSize: '12.5px' } }, name),
      sample(44, '永和九年 Aa Bb 0123'),
      sample(24, '天地玄黄，宇宙洪荒。The quick brown fox jumps over the lazy dog.'),
      sample(16, '一切有为法，如梦幻泡影。ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 ,.;:!?()[]{}')));
  }).catch(() => {
    if (token === S.rightToken) stage.replaceChildren(binaryCard(name, '', file.size));
  });
}

// ── markdown ────────────────────────────────────────────────────────────────

const ALLOWED_URL = /^(https?:|mailto:|#|\/|\.|[^:]*$)/i;
/** What marked writes, minus anything that runs: this page's origin holds the API. */
function sanitize(root) {
  for (const el of root.querySelectorAll('script, iframe, object, embed, style, link, meta, base, form')) el.remove();
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction') el.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'src' || n === 'xlink:href') && !ALLOWED_URL.test(attr.value.trim())) el.removeAttribute(attr.name);
    }
  }
}

/**
 * A bare URL followed by Chinese punctuation, `https://x.dev）。`, comes out
 * of marked with the punctuation inside the link. The link ends at it.
 */
function trimAutolinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const text = a.textContent;
    let href = a.getAttribute('href');
    try {
      href = decodeURI(href);
    } catch {
      continue;
    }
    // marked writes the punctuation into the href percent-encoded.
    if (text !== href || !/^https?:\/\//.test(text)) continue;
    const cut = text.search(/[）」』，。；：、！？》】]/);
    if (cut <= 0) continue;
    a.textContent = text.slice(0, cut);
    a.setAttribute('href', text.slice(0, cut));
    a.after(document.createTextNode(text.slice(cut)));
  }
}

function resolveRel(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

/**
 * Relative links in markdown point at the task's other files: `ctx.dir` is
 * the folder the markdown is in, from the task's own (`artifacts/c4`, or ''
 * for problem.md). Images load from the files origin; a link to an artifact
 * opens it here.
 */
function fixLinks(root, ctx) {
  if (!ctx.task) return;
  const files = detailOf(ctx.task)?.files || [];
  const resolve = (url) => {
    try {
      return resolveRel(ctx.dir || '', decodeURI(url.split(/[?#]/)[0]));
    } catch {
      return null;
    }
  };
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^[a-z]+:|^\/\/|^\//i.test(src)) continue;
    const rel = resolve(src);
    if (rel === null) continue;
    img.setAttribute('src', fileUrl(`tasks/${ctx.task}/${rel}`));
    img.loading = 'lazy';
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    if (/^[a-z]+:|^\/\//i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener';
      continue;
    }
    const rel = resolve(href);
    if (rel === null) continue;
    const art = rel.startsWith('artifacts/') ? rel.slice('artifacts/'.length) : null;
    if (art !== null && files.some((f) => f.path === art)) a.setAttribute('href', link.file(ctx.task, art));
    else if (art !== null && files.some((f) => f.path.startsWith(art + '/'))) a.setAttribute('href', link.folder(ctx.task, art));
    else {
      a.setAttribute('href', fileUrl(`tasks/${ctx.task}/${rel}`));
      a.target = '_blank';
    }
  }
}

function slug(text, used) {
  let s = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
  let n = s;
  for (let i = 2; used.has(n); i++) n = `${s}-${i}`;
  used.add(n);
  return n;
}

/**
 * Markdown as a document. `fresh`, when given, is the set of top-level
 * blocks' sources that were there before: every other block is tinted.
 */
function markdownDoc(text, ctx = {}) {
  const doc = h('div', { class: 'doc' });
  if (!window.marked) {
    doc.append(h('pre', null, text));
    return doc;
  }
  const tokens = marked.lexer(text, { gfm: true });
  // A title line repeats the heading the page already has.
  if (ctx.dropTitle) {
    const first = tokens.findIndex((x) => x.type !== 'space');
    if (first >= 0 && tokens[first].type === 'heading' && tokens[first].depth === 1) tokens.splice(first, 1);
  }
  if (ctx.before) {
    for (const tok of tokens) {
      const one = [tok];
      one.links = tokens.links;
      const html = marked.parser(one, { gfm: true });
      const holder = h('div');
      holder.innerHTML = html;
      if (tok.type !== 'space' && !ctx.before.has(tok.raw.trim())) {
        holder.className = 'fresh';
        doc.append(holder);
      } else doc.append(...holder.childNodes);
    }
  } else {
    doc.innerHTML = marked.parser(tokens, { gfm: true });
  }
  sanitize(doc);
  trimAutolinks(doc);
  fixLinks(doc, ctx);
  const used = new Set();
  const heads = [...doc.querySelectorAll('h1, h2, h3')];
  for (const el of heads) el.id = slug(el.textContent, used);
  if (!ctx.outline || heads.length < 3) return h('div', { class: 'doc-wrap' }, doc);
  const outline = h('nav', { class: 'outline', 'aria-label': 'Outline' }, h('b', null, 'On this page'),
    heads.map((el) => h('a', {
      href: '#',
      class: el.tagName === 'H3' ? 'l3' : '',
      onclick: (e) => {
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, el.textContent)));
  return h('div', { class: 'doc-wrap' }, doc, outline);
}

// ── right: a folder ─────────────────────────────────────────────────────────

/** A text file's card shows its first lines, read once the card scrolls near. */
const previews = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    previews.unobserve(e.target);
    const pre = e.target;
    textOf(`/blob/${pre.dataset.sha}`).then((text) => {
      pre.textContent = looksBinary(text) ? '' : text.split('\n').slice(0, 26).map((l) => l.slice(0, 140)).join('\n');
    }, () => undefined);
  }
}, { rootMargin: '300px' });

function wellOf(f, name) {
  if (kindOf(name) === 'image') return h('img', { src: shaUrl(f.sha, name), alt: '', loading: 'lazy' });
  const v = viewerOf(name);
  // The first frame, which the browser fetches by range without playing anything.
  if (v === 'video') return [h('video', { src: `${shaUrl(f.sha, name)}#t=0.1`, muted: true, preload: 'metadata', playsinline: true }), h('span', { class: 'corner-kind' }, badge(name))];
  if ((v === 'text' || v === 'markdown') && !(f.size > 400000)) {
    const pre = h('pre', { class: 'preview', 'data-sha': f.sha });
    previews.observe(pre);
    return [pre, h('span', { class: 'corner-kind' }, badge(name))];
  }
  return h('span', { class: 'big-kind' }, badge(name));
}

function viewFolder(t, d, path) {
  keyNav = { prev: null, next: null };
  const files = shownFiles(t.id, d);
  const tree = buildTree(files);
  let node = tree;
  for (const part of path ? path.split('/') : []) node = node?.dirs.get(part);
  if (!node) return emptyRight('Nothing here', `${path}/ has no files${filterOf(t.id) === 'all' ? '' : ' of this kind'}.`);
  const cards = [];
  for (const dir of sortedDirs(node)) {
    const cover = treeOrder(dir).find((f) => kindOf(f.path) === 'image');
    cards.push(h('a', { class: 'card', href: link.folder(t.id, dir.path) },
      h('span', { class: 'well' }, cover ? h('img', { src: shaUrl(cover.sha, baseName(cover.path)), alt: '', loading: 'lazy' }) : h('span', { class: 'big-kind' }, icon('folder', 22)), h('span', { class: 'folder-n', style: cover ? { color: '#fff', textShadow: '0 1px 2px #000' } : {} }, plural(dir.count, 'file'))),
      h('span', { class: 'cap' }, h('span', { class: 'dim', style: { display: 'flex' } }, icon('folder', 14)), h('span', null, dir.name))));
  }
  for (const f of sortedFiles(node)) {
    const name = baseName(f.path);
    cards.push(h('a', { class: 'card', href: link.file(t.id, f.path), title: f.path },
      h('span', { class: 'well' }, wellOf(f, name)),
      h('span', { class: 'cap' }, isNew(t.id, f) ? h('span', { class: 'dot' }) : null, h('span', null, name))));
  }
  R.replaceChildren(
    bar(path ? crumb(path) : 'Artifacts', `${plural(node.count, 'file')}${filterOf(t.id) === 'all' ? '' : ` · ${KIND_LABEL[filterOf(t.id)].toLowerCase()} only`}`,
      path ? h('div', { class: 'group-tools' }, h('a', { class: 'tool text', href: link.folder(t.id, dirName(path)) }, icon('prev', 16), 'Up')) : null),
    h('div', { class: 'scroll' }, h('div', { class: 'gallery' }, cards)));
}

function latestGallery() {
  keyNav = { prev: null, next: null };
  const files = feedFiles().slice(0, 80);
  if (!files.length) return emptyRight('Nothing yet', 'When an agent pushes an artifact, it shows up here.');
  R.replaceChildren(
    bar('Latest artifacts', `the ${plural(files.length, 'newest file')}, across every task`, null),
    h('div', { class: 'scroll' }, h('div', { class: 'gallery' }, files.map((f) => {
      const name = baseName(f.path);
      return h('a', { class: 'card', href: link.latest(f.task, f.path), title: `${f.task}/${f.path}` },
        h('span', { class: 'well' }, wellOf(f, name)),
        h('span', { class: 'cap' }, f.at > (S.latestBase ?? S.seen.latest) ? h('span', { class: 'dot' }) : null, h('span', null, name)),
        h('span', { class: 'cap dim', style: { fontSize: '12px', marginTop: '-4px' } }, h('span', null, `${S.byId.get(f.task)?.title || f.task} · ${when(f.at)}`)));
    }))));
}

// ── right: the overview and the log ─────────────────────────────────────────

function linkify(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>()（）「」，。；、]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener' }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function viewOverview(t, d, token) {
  keyNav = { prev: null, next: null };
  const pills = [];
  pills.push(t.state === 'open' ? h('span', { class: 'pill teal' }, 'In progress') : t.state === 'done' ? h('span', { class: 'pill green' }, 'Done') : h('span', { class: 'pill' }, 'Dropped'));
  const dates = [t.id, t.createdAt ? `started ${dayOf(fromIso(t.createdAt))}` : null, t.closedAt ? `${t.state === 'done' ? 'done' : 'closed'} ${dayOf(fromIso(t.closedAt))}` : null].filter(Boolean).join(' · ');
  pills.push(h('span', { class: 'pill' }, dates));
  d.repos.forEach((repo, i) => {
    if (repo.branch) pills.push(h('a', { class: 'pill', href: link.branch(t.id, i) }, icon('branch', 13), `${repo.name} · ${repo.branch}`));
    else pills.push(h('span', { class: 'pill' }, repo.name));
  });

  const paper = h('div', { class: 'paper' },
    h('header', { class: 'ov-head' }, h('div', { class: 'pills' }, pills), h('h2', null, t.title || t.id)));
  if (t.state === 'abandoned' && d.reason) paper.append(h('p', { class: 'notice' }, `Dropped: ${d.reason}`));

  // problem.md, with what changed since the last look tinted
  const problem = h('section', { class: 'ov-section' });
  paper.append(problem);
  if (d.problem && d.problem.text.trim()) {
    const name = baseName(d.problem.path);
    const was = S.problemBase.has(t.id) ? S.problemBase.get(t.id) : S.seen.problems[t.id];
    if (!S.problemBase.has(t.id)) S.problemBase.set(t.id, was ?? null);
    S.seen.problems[t.id] = d.problem.sha;
    saveSeen();
    const head = h('div', { class: 'h' }, h('h3', null, 'Problem'), h('span', null, `${name}${d.problem.changed ? ` · written ${when(d.problem.changed)}` : ''}`));
    const holder = h('div');
    problem.append(head, holder);
    const show = (before) => {
      if (token !== S.rightToken) return;
      holder.replaceChildren(markdownDoc(d.problem.text, { task: t.id, dir: '', before, dropTitle: true }).firstChild);
      if (before && holder.querySelector('.fresh')) problem.append(h('span', { class: 'dim', style: { fontSize: '12.5px' } }, 'The tinted parts are new since you last looked.'));
    };
    if (was && was !== d.problem.sha && window.marked) {
      textOf(`/blob/${was}`).then((old) => show(new Set(marked.lexer(old, { gfm: true }).map((x) => x.raw.trim()))), () => show(null));
    } else show(null);
  } else {
    problem.append(h('div', { class: 'h' }, h('h3', null, 'Problem')), h('span', { class: 'dim' }, 'No problem written yet.'));
  }

  // deliverables
  const ds = d.deliverables;
  if (ds.length) {
    const n = (s) => ds.filter((x) => x.status === s).length;
    const counts = [n('done') ? `${n('done')} done` : null, n('todo') ? `${n('todo')} to do` : null, n('abandoned') ? `${n('abandoned')} dropped` : null].filter(Boolean).join(' · ');
    paper.append(h('section', { class: 'ov-section' },
      h('div', { class: 'h' }, h('h3', null, 'Deliverables'), h('span', null, counts)),
      h('div', { class: 'rail' }, ds.map((x) => h('div', { class: `deliv ${x.status}` },
        h('span', { class: 'node', title: x.status }),
        h('span', null, h('span', { class: 'text' }, h('span', { class: 'id' }, x.id), x.text), x.reason ? h('span', { class: 'why' }, x.reason) : null),
        h('span', { class: 'at' }, x.doneAt ? x.doneAt.slice(5).replace('-', '.') : ''))))));
  }

  // resources
  if (d.resources.length) {
    paper.append(h('section', { class: 'ov-section' }, h('h3', null, 'Resources'),
      h('div', { class: 'res' }, d.resources.map(([k, v]) => h('div', null, h('span', { class: 'k' }, k), h('span', { class: 'v' }, linkify(v)))))));
  }
  R.replaceChildren(h('div', { class: 'scroll' }, paper));
}

function viewLog(t, d) {
  keyNav = { prev: null, next: null };
  const entries = d.log?.entries || [];
  const before = S.logBase.has(t.id) ? S.logBase.get(t.id) : S.seen.logs[t.id] ?? entries.length;
  if (!S.logBase.has(t.id)) S.logBase.set(t.id, before);
  S.seen.logs[t.id] = entries.length;
  saveSeen();
  const year = new Date((fromIso(t.createdAt) || nowS()) * 1000).getFullYear();
  const paper = h('div', { class: 'paper' });
  if (!entries.length) paper.append(h('div', { class: 'empty' }, 'No log yet.'));
  let day = '';
  const list = entries.map((e, i) => ({ e, i })).reverse();
  for (const { e, i } of list) {
    if (e.day !== day) {
      day = e.day;
      const [mm, dd] = e.day.split('-').map(Number);
      const label = `${MONTHS[mm - 1] || mm} ${dd}`;
      const ts = Math.floor(new Date(year, mm - 1, dd).getTime() / 1000);
      paper.append(h('div', { class: 'log-day' }, sameDay(new Date(ts * 1000), new Date()) ? `Today · ${label}` : label));
    }
    paper.append(h('div', { class: 'log-entry' + (i >= before ? ' fresh' : '') }, h('span', { class: `log-type ${e.type}` }, e.type), h('span', { class: 'txt' }, linkify(e.text))));
  }
  R.replaceChildren(bar('Log', `${plural(entries.length, 'entry', 'entries')}, newest first · log.md${d.log?.changed ? ` · written ${when(d.log.changed)}` : ''}`, null), h('div', { class: 'scroll' }, paper));
}

// ── right: a branch ─────────────────────────────────────────────────────────

function parsePatch(patch) {
  const files = [];
  let f = null;
  let hunk = null;
  let a = 0;
  let b = 0;
  const unq = (p) => (p.startsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p);
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { from: null, to: null, hunks: [], binary: false, note: [] };
      files.push(f);
      hunk = null;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (!m) continue;
      a = Number(m[1]);
      b = Number(m[2]);
      hunk = { head: line, lines: [] };
      f.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith('--- ')) f.from = unq(line.slice(4)).replace(/^a\//, '');
      else if (line.startsWith('+++ ')) f.to = unq(line.slice(4)).replace(/^b\//, '');
      else if (line.startsWith('Binary files')) f.binary = true;
      else if (line.startsWith('rename from ')) f.from = line.slice(12);
      else if (line.startsWith('rename to ')) f.to = line.slice(10);
      else if (line.startsWith('new file mode')) f.note.push('new file');
      else if (line.startsWith('deleted file mode')) f.note.push('deleted');
      continue;
    }
    const c = line.charAt(0);
    if (c === '+') hunk.lines.push({ k: 'add', b: b++, t: line.slice(1) });
    else if (c === '-') hunk.lines.push({ k: 'del', a: a++, t: line.slice(1) });
    else if (c === ' ') hunk.lines.push({ k: 'ctx', a: a++, b: b++, t: line.slice(1) });
  }
  for (const x of files) x.path = x.to && x.to !== '/dev/null' ? x.to : x.from;
  return files;
}

const DIFF_LIMIT = 5000;
function diffBody(f, layout) {
  const box = h('div');
  if (f.binary) return h('div', { class: 'dl' }, h('span', { class: 't', style: { padding: '10px 14px', fontFamily: 'var(--font)' } }, 'A binary file: no lines to compare.'));
  if (!f.hunks.length) return h('div', { class: 'dl' }, h('span', { class: 't', style: { padding: '10px 14px', fontFamily: 'var(--font)' } }, f.note.length ? `${f.note.join(', ')}, empty` : 'Only the mode changed.'));
  let count = 0;
  const rows = [];
  for (const hk of f.hunks) {
    if (layout === 'split') {
      rows.push(h('div', { class: 'hunk' }, hk.head));
      const pairs = splitPairs(hk.lines);
      for (const [l, r] of pairs) {
        rows.push(half(l, 'a'), half(r, 'b'));
        count++;
      }
    } else {
      rows.push(h('div', { class: 'dl hunk' }, h('span', { class: 'a' }), h('span', { class: 'b' }), h('span', { class: 's' }), h('span', { class: 't' }, hk.head)));
      for (const l of hk.lines) {
        rows.push(h('div', { class: `dl ${l.k}` }, h('span', { class: 'a' }, l.a ?? ''), h('span', { class: 'b' }, l.b ?? ''), h('span', { class: 's' }, l.k === 'add' ? '+' : l.k === 'del' ? '−' : ''), h('span', { class: 't' }, l.t || ' ')));
        count++;
      }
    }
    if (count > DIFF_LIMIT) {
      rows.push(h('div', { class: 'dl', style: { gridColumn: '1 / -1' } }, h('span', { class: 't', style: { padding: '10px 14px', fontFamily: 'var(--font)', color: 'var(--ink-3)' } }, `Cut at ${DIFF_LIMIT.toLocaleString()} lines.`)));
      break;
    }
  }
  if (layout === 'split') box.className = 'split';
  append(box, rows);
  return box;
}
function splitPairs(lines) {
  const out = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push([dels[i] || null, adds[i] || null]);
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.k === 'del') {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.k === 'add') adds.push(l);
    else {
      flush();
      out.push([l, l]);
    }
  }
  flush();
  return out;
}
function half(l, side) {
  if (!l) return h('div', { class: 'half none' }, h('span', { class: 'a' }), h('span', { class: 't' }));
  const cls = l.k === 'ctx' ? '' : ` ${l.k}`;
  return h('div', { class: 'half' + cls }, h('span', { class: 'a' }, side === 'a' ? l.a ?? '' : l.b ?? ''), h('span', { class: 't' }, l.t || ' '));
}

function viewBranch(t, r, token) {
  keyNav = { prev: null, next: null };
  const b = branchOf(t.id, r.repo);
  if (!b) return emptyRight('Reading the branch…');
  if (b.missing) return emptyRight('Nothing to show', b.missing);
  const github = b.links.branch ? b.links.branch.replace(/\/tree\/.*$/, '') : null;

  if (r.tab === 'commits') {
    const sha = r.item || b.commits[0]?.sha;
    const at = b.commits.findIndex((c) => c.sha === sha);
    if (!sha) return emptyRight('No commits', `${b.branch} has nothing ${b.target} does not.`);
    keyNav = {
      prev: at > 0 ? link.branch(t.id, r.repo, 'commits', b.commits[at - 1].sha) : null,
      next: at >= 0 && at < b.commits.length - 1 ? link.branch(t.id, r.repo, 'commits', b.commits[at + 1].sha) : null,
    };
    const scroll = h('div', { class: 'diff-scroll' }, h('div', { class: 'empty' }, 'Loading…'));
    const c = b.commits[at] || { sha, subject: short(sha), author: '', at: 0 };
    R.replaceChildren(
      bar(c.subject, `${short(c.sha)} · ${c.author}${c.at ? ` · ${when(c.at)}` : ''}`, [
        navTools(at + 1, b.commits.length),
        h('span', { class: 'sep' }),
        layoutTools(),
        github ? tool('external', 'Open the commit on GitHub', null, { href: `${github}/commit/${c.sha}` }) : null,
      ]),
      scroll);
    getJSON(`/api/branch/commit?task=${encodeURIComponent(t.id)}&repo=${r.repo}&sha=${sha}`).then((full) => {
      if (token !== S.rightToken) return;
      const files = parsePatch(full.patch);
      scroll.replaceChildren();
      append(scroll, [
        full.body ? h('div', { class: 'commit-body' }, full.body) : null,
        full.truncated ? h('div', { class: 'notice' }, 'This commit is too big to show whole; it is cut short.') : null,
        files.map((f) => h('div', { class: 'diff' }, h('div', { class: 'diff-file-head' }, h('a', { href: link.branch(t.id, r.repo, 'changes', f.path) }, f.path), f.note.length ? h('span', { class: 'dim' }, f.note.join(', ')) : null), diffBody(f, S.prefs.layout)))]);
    }, (err) => scroll.replaceChildren(h('div', { class: 'empty error' }, String(err.message || err))));
    return undefined;
  }

  if (r.tab === 'files') {
    if (!r.item) {
      keyNav = { prev: null, next: null };
      return emptyRight(`${b.repo} at ${short(b.head)}`, `Every file on ${b.branch} — pick one in the middle.`);
    }
    const tree = S.branchTrees.get(b.head);
    const entry = tree?.find((f) => f.path === r.item);
    if (!tree) return emptyRight('Reading the files…');
    if (!entry) return emptyRight('Not on the branch', `${r.item} is not on ${b.branch}.`);
    const name = baseName(entry.path);
    const url = `/api/branch/blob?task=${encodeURIComponent(t.id)}&repo=${r.repo}&sha=${entry.sha}`;
    const meta = h('span', null, bytes(entry.size));
    const stage = h('div', { class: 'stage' });
    if (kindOf(name) === 'image' && ext(name) !== 'svg') {
      stage.classList.toggle('dark', !!S.prefs.dark);
      stage.append(h('img', { class: 'shot', src: `${url}&name=${encodeURIComponent(name)}`, alt: name }));
    } else if (viewerOf(name) === 'markdown') {
      stage.classList.add('top');
      textOf(url).then((text) => {
        if (token === S.rightToken) stage.replaceChildren(h('div', { style: { background: '#fff', borderRadius: '12px', boxShadow: '0 0 0 1px var(--line)', width: '100%', maxWidth: '1000px' } }, markdownDoc(text, {})));
      });
    } else {
      stage.classList.add('top');
      fillCode(stage, url, name, token, meta, entry.size);
    }
    R.replaceChildren(
      bar(crumb(entry.path), meta, [
        github ? tool('external', 'Open the file on GitHub', null, { href: `${github}/blob/${b.head}/${enc(entry.path)}` }) : null,
      ]),
      stage);
    return undefined;
  }

  // changes
  const path = r.item || b.files[0]?.path;
  if (!path) return emptyRight('No changes', `${b.branch} changes nothing against ${b.target}.`);
  const at = b.files.findIndex((f) => f.path === path);
  const f = b.files[at];
  if (!f) return emptyRight('Not in this branch', `${path} is not among the files ${b.branch} changes.`);
  keyNav = {
    prev: at > 0 ? link.branch(t.id, r.repo, 'changes', b.files[at - 1].path) : null,
    next: at < b.files.length - 1 ? link.branch(t.id, r.repo, 'changes', b.files[at + 1].path) : null,
  };
  const against = b.merged ? `as merged${b.merged.pr ? ` in PR #${b.merged.pr}` : ''}, against ${b.target} at ${short(b.base)}` : `against ${b.target} at ${short(b.base)}`;
  const meta = h('span', null,
    f.add === null ? 'binary' : [h('span', { style: { color: 'var(--green)' } }, `+${f.add}`), ' ', h('span', { style: { color: 'var(--red)' } }, `−${f.del}`)],
    f.from ? ` · renamed from ${f.from}` : '', ` · ${against}`);
  const scroll = h('div', { class: 'diff-scroll' }, h('div', { class: 'empty' }, 'Loading…'));
  R.replaceChildren(
    bar(crumb(f.path), meta, [
      navTools(at + 1, b.files.length),
      h('span', { class: 'sep' }),
      layoutTools(),
      h('button', { type: 'button', class: 'tool text', 'aria-pressed': String(!!S.prefs.whole), onclick: () => { S.prefs.whole = !S.prefs.whole; savePrefs(); renderRight(); } }, 'Whole file'),
      github && f.status !== 'D' ? tool('external', 'Open the file on GitHub', null, { href: `${github}/blob/${b.head}/${enc(f.path)}` }) : null,
    ]),
    scroll);
  const q = new URLSearchParams({ task: t.id, repo: String(r.repo), base: b.base, head: b.head, path: f.path, context: S.prefs.whole ? 'all' : '3' });
  if (f.from) q.set('from', f.from);
  textOf(`/api/branch/diff?${q}`).then((patch) => {
    if (token !== S.rightToken) return;
    const files = parsePatch(patch);
    const one = files[0] || { hunks: [], binary: f.add === null, note: [] };
    const hunks = one.hunks.length;
    if (hunks) meta.append(` · ${plural(hunks, 'hunk')}`);
    scroll.replaceChildren(h('div', { class: 'diff' }, diffBody(one, S.prefs.layout)));
  }, (err) => scroll.replaceChildren(h('div', { class: 'empty error' }, String(err.message || err))));
  return undefined;
}
function navTools(pos, total) {
  return h('div', { class: 'group-tools' },
    tool('prev', 'Previous (←)', null, { href: keyNav.prev, newTab: false, disabled: !keyNav.prev }),
    h('span', { class: 'counter' }, `${pos} / ${total}`),
    tool('next', 'Next (→)', null, { href: keyNav.next, newTab: false, disabled: !keyNav.next }));
}
function layoutTools() {
  return seg([['unified', 'Unified'], ['split', 'Split']], S.prefs.layout, (v) => {
    S.prefs.layout = v;
    savePrefs();
    renderRight();
  });
}

// ── moving around ───────────────────────────────────────────────────────────

async function onRoute() {
  const before = S.route;
  S.route = parseRoute();
  const r = S.route;
  S.page.source = false;
  if (before.view === 'task' && (r.view !== 'task' || r.id !== before.id)) {
    S.visit.delete(before.id);
    S.problemBase.delete(before.id);
    S.logBase.delete(before.id);
  }
  if (before.view === 'latest' && r.view !== 'latest') S.latestBase = null;
  if (!S.index) return;

  if (r.view === 'task' && S.byId.has(r.id)) {
    S.last.set(r.id, location.hash);
    markTaskSeen(r.id);
    const need = [];
    if (!detailOf(r.id) || S.tasks.get(r.id).version !== S.version) need.push(loadTask(r.id));
    if (r.sub === 'branch' && !branchOf(r.id, r.repo)) need.push(loadBranch(r.id, r.repo).catch(() => undefined));
    if (need.length) {
      render();
      await Promise.all(need).catch((err) => toast(String(err.message || err)));
    }
    if (r.sub === 'file' || r.sub === 'folder') {
      const d = detailOf(r.id);
      if (d) {
        expandedFor(r.id, d.files);
        openTo(r.id, r.sub === 'file' ? dirName(r.path) : r.path);
        if (r.sub === 'file' && filterOf(r.id) !== 'all' && kindOf(r.path) !== filterOf(r.id)) S.filter.set(r.id, 'all');
      }
    }
  } else if (r.view === 'latest') {
    markLatestSeen();
    if (r.id && S.byId.has(r.id) && !detailOf(r.id)) {
      render();
      await loadTask(r.id).catch((err) => toast(String(err.message || err)));
    }
  }
  render();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!S.prefs.left) setLeft(true);
    left.find.focus();
    left.find.select();
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft' && keyNav.prev) {
    e.preventDefault();
    location.hash = keyNav.prev;
  } else if (e.key === 'ArrowRight' && keyNav.next) {
    e.preventDefault();
    location.hash = keyNav.next;
  } else if (e.key === 'f' || e.key === 'F') {
    const stage = R.querySelector('.stage');
    if (stage && stage.querySelector('img.shot')) {
      if (document.fullscreenElement) document.exitFullscreen();
      else stage.requestFullscreen?.();
    }
  }
});

async function start() {
  buildLeft();
  setLeft(S.prefs.left !== false);
  window.addEventListener('hashchange', () => void onRoute());
  try {
    await loadIndex();
  } catch (err) {
    S.connected = false;
    renderSync();
    emptyRight("Can't reach yan serve", String(err.message || err));
    return;
  }
  connect();
  await onRoute();
}
void start();
