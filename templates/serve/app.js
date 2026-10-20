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
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M4 18h5"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M8.5 6.3A6 6 0 0 1 18 11v5.5l1.5 2H9"/><path d="M6 11v5.5l-1.5 2h2"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="m4 4 16 16"/>',
};
const STATES = {
  open: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#0b7285" stroke-width="1.5"/><path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="#0b7285"/>',
  done: '<circle cx="8" cy="8" r="7" fill="#1f7a3d"/><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  abandoned: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#66655f" stroke-width="1.5"/><path d="m4.2 11.8 7.6-7.6" stroke="#66655f" stroke-width="1.5"/>',
  uat: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#a15c07" stroke-width="1.5"/><circle cx="8" cy="8" r="2.75" fill="#a15c07"/>',
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
    else if (k === 'html') el.innerHTML = v;
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
    class: 'tool' + (opts.small ? ' small' : '') + (opts.blocked ? ' blocked' : ''),
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

// ── colour by language ──────────────────────────────────────────────────────
//
// highlight.js, served from yan's own node_modules as marked is. Its common
// languages come with it; one outside them is fetched from the same place the
// first time a file needs it, and a file whose language is not known here, or
// too long to colour quickly, stays plain. The colours are the page's own,
// `.hljs-*` in app.css, chosen to read on the add and del tints as well.

const LANG_OF_EXT = {};
const langs = {
  javascript: 'js mjs cjs jsx',
  typescript: 'ts tsx mts cts',
  json: 'json jsonl jsonc json5',
  css: 'css',
  scss: 'scss',
  less: 'less',
  xml: 'xml html htm xhtml svg vue svelte xsl plist',
  python: 'py pyi',
  bash: 'sh bash zsh env',
  powershell: 'ps1 psm1',
  dos: 'bat cmd',
  ruby: 'rb rake gemspec',
  go: 'go',
  rust: 'rs',
  java: 'java',
  kotlin: 'kt kts',
  swift: 'swift',
  c: 'c h',
  cpp: 'cpp cc cxx hpp hh hxx',
  csharp: 'cs',
  objectivec: 'm mm',
  php: 'php',
  perl: 'pl pm',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  scala: 'scala sbt',
  elixir: 'ex exs',
  erlang: 'erl',
  haskell: 'hs',
  clojure: 'clj cljs edn',
  ocaml: 'ml mli',
  julia: 'jl',
  yaml: 'yaml yml',
  ini: 'ini toml cfg',
  sql: 'sql',
  graphql: 'graphql gql',
  protobuf: 'proto',
  diff: 'diff patch',
  makefile: 'mk',
  cmake: 'cmake',
  dockerfile: 'dockerfile',
  nginx: 'nginx',
  markdown: 'md markdown',
  latex: 'tex',
  vim: 'vim',
  groovy: 'groovy gradle',
};
for (const [lang, list] of Object.entries(langs)) for (const e of list.split(' ')) LANG_OF_EXT[e] = lang;
/** Files known by their whole name rather than an extension. */
const LANG_OF_NAME = {
  makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'dockerfile', containerfile: 'dockerfile', 'cmakelists.txt': 'cmake',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash', '.zprofile': 'bash', '.profile': 'bash',
  '.npmrc': 'ini', '.gitconfig': 'ini', '.editorconfig': 'ini', '.gitignore': 'plaintext', '.gitattributes': 'plaintext',
};
/** highlight.js's name for the language of a file, or null when it is not known here. */
function langOf(path) {
  const n = baseName(path).toLowerCase();
  return LANG_OF_NAME[n] || LANG_OF_EXT[ext(n)] || null;
}
/** The language a fenced block names: highlight.js's own names and aliases, or an extension. */
function langOfFence(info) {
  if (!info || !window.hljs) return null;
  return hljs.getLanguage(info) ? info : LANG_OF_EXT[info] || LANG_OF_NAME[info] || null;
}

const langLoads = new Map();
/** Resolves once highlight.js can colour `lang`, or once it is clear that it cannot. */
function langReady(lang) {
  if (!lang || !window.hljs || hljs.getLanguage(lang)) return Promise.resolve();
  let p = langLoads.get(lang);
  if (!p) {
    p = new Promise((done) => document.head.append(h('script', { src: `/vendor/highlight/${lang}.js`, onload: done, onerror: done })));
    langLoads.set(lang, p);
  }
  return p;
}

/** Long enough for any file a person reads in colour; past it, plain text comes faster. */
const COLOUR_LIMIT = 400_000;
/**
 * `text` coloured as `lang`, one HTML string per line, or null when it
 * cannot be. The whole text is coloured at once, so a comment or a string
 * that runs over several lines is right on every one of them; the markup is
 * then cut at each newline, closing every span still open and reopening it
 * on the next line.
 */
function colourLines(lang, text) {
  if (!lang || !window.hljs || !hljs.getLanguage(lang) || text.length > COLOUR_LIMIT) return null;
  let html;
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  const lines = [];
  const open = [];
  let line = '';
  for (const piece of html.match(/<span class="[^"]*">|<\/span>|\n|[^<\n]+/g) || []) {
    if (piece === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      if (piece === '</span>') open.pop();
      else if (piece.startsWith('<span')) open.push(piece);
      line += piece;
    }
  }
  lines.push(line + '</span>'.repeat(open.length));
  return lines.length === text.split('\n').length ? lines : null;
}
/**
 * Each side of a hunk coloured as one piece: the old side (context and
 * removed lines) by old line number, the new (context and added) by new.
 * A side too long to colour gives an empty map, and its lines stay plain.
 */
function colourSides(hk, lang) {
  const old = hk.lines.filter((l) => l.k !== 'add');
  const now = hk.lines.filter((l) => l.k !== 'del');
  const a = colourLines(lang, old.map((l) => l.t).join('\n'));
  const b = colourLines(lang, now.map((l) => l.t).join('\n'));
  return { byA: new Map(a ? old.map((l, i) => [l.a, a[i]]) : []), byB: new Map(b ? now.map((l, i) => [l.b, b[i]]) : []) };
}
/**
 * Colour a parsed file's hunks in place. With `whole`, the same file's diff
 * with every line as context, each side is coloured entire, so a construct
 * is right however far it spans and wherever a hunk cuts it. Without, each
 * hunk's two sides are coloured on their own, and one open at a hunk's
 * edge, a block comment most often, is read as code until it closes.
 */
function colourPatch(f, lang, whole = null) {
  if (!lang || !window.hljs || !hljs.getLanguage(lang)) return;
  const entire = whole && whole.hunks.length === 1 ? colourSides(whole.hunks[0], lang) : null;
  for (const hk of f.hunks) {
    const { byA, byB } = entire || colourSides(hk, lang);
    for (const l of hk.lines) l.h = l.k === 'del' ? byA.get(l.a) : byB.get(l.b);
  }
}
/** A line's text as the page shows it: coloured when it was, plain otherwise. */
const codeText = (l) => (l.h != null ? h('span', { class: 't', html: l.h || ' ' }) : h('span', { class: 't' }, l.t || ' '));
/** Fenced blocks that name a language, `<pre><code class="language-ts">` as marked writes them. */
function colourBlocks(root) {
  for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = langOfFence((/language-(\S+)/.exec(code.className) || [])[1]?.toLowerCase());
    if (!lang) continue;
    langReady(lang).then(() => {
      const lines = colourLines(lang, code.textContent.replace(/\n$/, ''));
      if (lines) code.innerHTML = lines.join('\n');
    });
  }
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
  feedOpen: new Set(),
  last: new Map(),
  query: '',
  rightKey: '',
  rightToken: 0,
  page: { source: false, mdSource: false },
  prefs: Object.assign({ left: true, dark: false, layout: 'unified', width: 'fit', whole: false, wrap: {}, notify: false }, load('yan.serve.prefs', {})),
  seen: load('yan.serve.seen', null),
  told: null,
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
  report: (id) => `#/t/${id}/report`,
  file: (id, p) => `#/t/${id}/a/${enc(p)}`,
  folder: (id, p) => `#/t/${id}/a/${p ? enc(p) + '/' : ''}`,
  branch: (id, repo, tab, item, name) => `#/t/${id}/b/${repo}${name ? '/' + encodeURIComponent(name) : ''}/${tab || 'changes'}${item ? '/' + enc(item) : ''}`,
  latest: (id, p) => (id ? `#/latest/${id}/${enc(p)}` : '#/latest'),
};

const BRANCH_TABS = ['changes', 'commits', 'files'];

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
    if (rest[0] === 'report') return { view: 'task', id, sub: 'report' };
    if (rest[0] === 'a') {
      const p = rest.slice(1).join('/');
      if (p === '' || raw.endsWith('/')) return { view: 'task', id, sub: 'folder', path: p.replace(/\/$/, '') };
      return { view: 'task', id, sub: 'file', path: p };
    }
    if (rest[0] === 'b') {
      // `b/<repo>/<tab>/…` is the branch the task is on; `b/<repo>/<branch>/<tab>/…` an earlier one.
      const named = rest[2] !== undefined && !BRANCH_TABS.includes(rest[2]);
      const at = named ? 3 : 2;
      return { view: 'task', id, sub: 'branch', repo: Number(rest[1]) || 0, name: named ? rest[2] : null, tab: rest[at] || 'changes', item: rest.slice(at + 1).join('/') };
    }
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
  S.seen = { init: newest, tasks: {}, problems: {}, logs: {} };
  saveSeen();
}
const seenAt = (id) => S.seen.tasks[id] ?? S.seen.init;
/** The newest time anything arrived in a task: its files, and every push in the feed, deletions included. */
function newestOf(id) {
  const t = S.byId.get(id);
  return Math.max(t?.touched || 0, t?.added[0] || 0, ...S.index.latest.filter((p) => p.task === id).map((p) => p.at));
}
/** What arrived in a task since it was last looked at, each file once, as where it ended up: added, changed or deleted. */
function unseenFiles(id) {
  const base = seenAt(id);
  const files = new Map();
  // Newest push first, so a file's first status is its last.
  for (const p of S.index.latest) if (p.task === id && p.at > base) for (const f of p.files) if (!files.has(f.path)) files.set(f.path, f);
  return [...files.values()];
}
/**
 * A task counts as seen once it, or a file of it, is opened, wherever from:
 * its row in the list, Latest, or a link. The mark from before is kept for
 * the visit, so what was new stays marked until the page moves on.
 */
function markTaskSeen(id) {
  if (!S.byId.has(id)) return;
  if (!S.visit.has(id)) S.visit.set(id, seenAt(id));
  S.seen.tasks[id] = Math.max(seenAt(id), newestOf(id));
  saveSeen();
}
const isNew = (id, file) => file.added > (S.visit.get(id) ?? seenAt(id));
/** How many tasks have something new: Latest's count, which falls as each is opened. */
function latestUnseen() {
  return S.index ? new Set(S.index.latest.filter((p) => p.at > seenAt(p.task)).map((p) => p.task)).size : 0;
}

// ── a notification when a push arrives ──────────────────────────────────────
//
// Latest's count is only in the page, and `user` works in other windows most
// of the time, so a push went unnoticed until they looked. Chrome hands a
// Notification to macOS, which shows it over whatever is in front. The page
// has to be open for that, in the background or minimised: there is no push
// service behind it, and none is wanted for a tool on this machine.
//
// A notification says only which task moved, its name as the title: `user`
// opens the task to see what came. One per task, a later push replacing the
// earlier, silent. Chrome asks its permission only on a click, so the bell by
// Latest asks; whether to notify is this browser's choice, kept in its prefs.

const canNotify = () => typeof Notification !== 'undefined';
const notifying = () => canNotify() && S.prefs.notify && Notification.permission === 'granted';

/** The favicon as a bitmap: Chrome draws a notification's icon from one, not from SVG. */
let logoPng = null;
function logoIcon() {
  if (!logoPng) {
    logoPng = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 192;
        c.getContext('2d').drawImage(img, 0, 0, 192, 192);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve('');
      img.src = document.querySelector('link[rel="icon"]').href;
    });
  }
  return logoPng;
}

/** Whether the page is in front, showing where the task's push would be seen: the task itself, or Latest. */
function inFront(task) {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const r = S.route;
  return r.view === 'latest' || (r.view === 'task' && r.id === task);
}

/**
 * Tells of each task whose newest push is newer than the last one told of.
 * The first index fills the marks without telling: what was there when the
 * page opened is Latest's to show, not a burst of notifications.
 */
function tellOfPushes() {
  const newest = new Map();
  for (const p of S.index.latest) if (p.at > (newest.get(p.task)?.at ?? 0)) newest.set(p.task, p);
  if (!S.told) {
    S.told = new Map([...newest].map(([task, p]) => [task, p.at]));
    return;
  }
  for (const [task, p] of newest) {
    if (p.at <= (S.told.get(task) ?? 0)) continue;
    S.told.set(task, p.at);
    if (notifying() && !inFront(task)) void notify(task, p);
  }
}

async function notify(task, p) {
  const t = S.byId.get(task);
  const icon = await logoIcon();
  let n;
  try {
    n = new Notification(t?.title ? `${t.title} · ${task}` : task, { tag: `yan:${task}`, silent: true, icon: icon || undefined });
  } catch {
    return; // Chrome on Android wants a service worker for these; this page is not for it
  }
  // Clicking opens Latest on the push, as the push's own line would.
  n.onclick = () => {
    n.close();
    window.focus();
    S.feedOpen.add(`${task}@${p.at}`);
    if (location.hash === '#/latest') render();
    else location.hash = '#/latest';
  };
}

/** The bell: asks Chrome the first time, and after that turns notifying on and off for this browser. */
async function toggleNotify() {
  if (notifying()) {
    S.prefs.notify = false;
    savePrefs();
    renderLeft();
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Chrome blocks notifications from this page: allow them from the icon left of the address bar');
    return;
  }
  const got = await Notification.requestPermission();
  S.prefs.notify = got === 'granted';
  savePrefs();
  if (got === 'granted') toast('Chrome will say when a push arrives');
  renderLeft();
}
function bell() {
  if (!canNotify()) return null;
  if (Notification.permission === 'denied') {
    return tool('bellOff', 'Chrome blocks notifications from this page. Allow them from the icon left of the address bar.', toggleNotify, { small: true, blocked: true });
  }
  const on = notifying();
  return tool('bell', on ? 'Chrome says when a push arrives. Click to stop.' : 'Have Chrome say when a push arrives', toggleNotify, { small: true, pressed: on });
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
  tellOfPushes();
}
async function loadTask(id, force) {
  const have = S.tasks.get(id);
  if (have && have.version === S.version && !force) return have.detail;
  const detail = await getJSON(`/api/task/${encodeURIComponent(id)}`);
  S.tasks.set(id, { detail, version: S.version });
  return detail;
}
const detailOf = (id) => S.tasks.get(id)?.detail;
async function loadBranch(id, repo, name, fresh) {
  const v = await getJSON(`/api/branch?task=${encodeURIComponent(id)}&repo=${repo}${name ? `&branch=${encodeURIComponent(name)}` : ''}${fresh ? '&fresh=1' : ''}`);
  S.branches.set(`${id}:${repo}:${name || ''}`, v);
  return v;
}
/** Every other branch the task kept in a repository, read in the background for what the nav says of each. */
function loadEarlier(id, repo) {
  const t = S.byId.get(id);
  for (const name of [null, ...(t?.repos[repo]?.earlier || [])]) {
    if (!branchOf(id, repo, name)) void loadBranch(id, repo, name).then(() => renderMiddle(), () => undefined);
  }
}
/** A link inside the branch being looked at. */
const inBranch = (r, tab, item) => link.branch(r.id, r.repo, tab, item, r.name);
const branchOf = (id, repo, name) => S.branches.get(`${id}:${repo}:${name || ''}`);
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
      await loadBranch(at.id, at.repo, at.name, true);
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
  // A yan serve that restarted on a newer yan: this page is the old one, so it loads the new.
  if (st.build && S.build && st.build !== S.build) return location.reload();
  if (st.build) S.build = st.build;
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
        if (r.view === 'latest' && r.id) markTaskSeen(r.id);
        render();
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  const r = S.route;
  if (r.view === 'task' && r.sub === 'branch' && S.byId.has(r.id)) {
    const before = branchOf(r.id, r.repo, r.name);
    try {
      const after = await loadBranch(r.id, r.repo, r.name);
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
  left.latest = h('div', { class: 'latest-line' });
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
  const fresh = on ? [] : unseenFiles(t.id);
  return h('a', { class: 'row' + (on ? ' on' : ''), href: S.last.get(t.id) || link.task(t.id), title: `${t.title || t.id} · ${t.id}` },
    stateIcon(t.state),
    h('span', { class: 'grow' }, t.title || t.id),
    fresh.length ? h('span', { class: 'tags', title: 'since you last looked' }, pushTags(fresh)) : null);
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
    // Waiting on `user`, so above the rest; the group is not there when none is.
    const uat = tasks.filter((t) => t.state === 'uat').sort((a, b) => b.touched - a.touched);
    if (uat.length) parts.push(h('div', { class: 'group' }, h('div', { class: 'label' }, '待验收'), uat.map((t) => taskRow(t))));

    const open = tasks.filter((t) => t.state === 'open').sort((a, b) => b.touched - a.touched);
    parts.push(h('div', { class: 'group' }, h('div', { class: 'label' }, 'In progress'), open.length ? open.map((t) => taskRow(t)) : h('div', { class: 'sublabel' }, 'Nothing open')));

    const closed = tasks.filter((t) => t.state === 'done' || t.state === 'abandoned').sort((a, b) => (fromIso(b.closedAt) || b.touched) - (fromIso(a.closedAt) || a.touched));
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
  left.latest.className = 'latest-line' + (onLatest ? ' on' : '');
  left.latest.replaceChildren(h('a', { class: 'row' + (onLatest ? ' on' : ''), href: '#/latest', style: { fontWeight: 700 } },
    icon('latest', 17), h('span', { class: 'grow' }, 'Latest'), unseen > 0 ? h('span', { class: 'badge solid', title: `${plural(unseen, 'task')} with something new` }, unseen) : null),
    bell());
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
  else if (t.state === 'uat') bits.push('待验收');
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
  if (d?.files.some((f) => f.path === 'report.html')) {
    nav.push(h('a', { class: 'row' + (r.sub === 'report' ? ' on' : ''), href: link.report(t.id) },
      icon('check', 16), h('span', { class: 'grow' }, 'Report'), h('span', { class: 'aside' }, 'report.html')));
  }
  const logCount = d?.log?.entries.length ?? 0;
  const logFresh = d?.log && logCount > (S.logBase.get(t.id) ?? S.seen.logs[t.id] ?? logCount);
  nav.push(h('a', { class: 'row' + (r.sub === 'log' ? ' on' : ''), href: link.log(t.id) },
    icon('log', 16), h('span', { class: 'grow' }, 'Log'), logFresh ? h('span', { class: 'dot', title: 'new entries' }) : null, h('span', { class: 'aside' }, d ? logCount : '')));
  t.repos.forEach((repo, i) => {
    if (!repo.branch) return;
    const here = r.sub === 'branch' && r.repo === i;
    const prOf = (name) => branchOf(t.id, i, name)?.merged?.pr;
    const now = prOf(null);
    const many = t.repos.length > 1;
    nav.push(h('a', { class: 'row branch-row' + (here && !r.name ? ' on' : ''), href: link.branch(t.id, i), title: `${repo.name} · ${repo.branch}` },
      icon('branch', 16),
      h('span', { class: 'word' }, 'Branch'),
      h('span', { class: 'name mono dim' }, repo.branch),
      many ? h('span', { class: 'repo' }, repo.name) : null,
      now ? h('span', { class: 'aside' }, `${many ? '· ' : ''}PR #${now}`) : null));
    for (const name of [...(repo.earlier || [])].reverse()) {
      const pr = prOf(name);
      nav.push(h('a', { class: 'row earlier' + (here && r.name === name ? ' on' : ''), href: link.branch(t.id, i, 'changes', '', name), title: `${repo.name} · ${name}, before ${repo.branch}` },
        h('span', { class: 'grow mono' }, name),
        h('span', { class: 'aside' }, pr ? `PR #${pr}` : 'earlier')));
    }
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

/** A folder that holds only one folder is shown as one row with it, so a long path stays shallow. */
function compactDir(dir) {
  let name = dir.name;
  while (!dir.files.length && dir.dirs.size === 1) {
    dir = dir.dirs.values().next().value;
    name += '/' + dir.name;
  }
  return { name, dir };
}

/** Rows of a tree. A folder row opens its folder's page when there is `folderHref`, and only opens and closes otherwise. */
function treeRows(node, depth, ctx, out) {
  for (const top of sortedDirs(node)) {
    const { name, dir } = ctx.compact ? compactDir(top) : { name: top.name, dir: top };
    const open = ctx.open.has(dir.path);
    const current = ctx.folder === dir.path;
    const toggle = () => {
      if (open) ctx.open.delete(dir.path);
      else ctx.open.add(dir.path);
      renderMiddle();
    };
    const chev = h('span', {
      class: 'chev', role: 'button', 'aria-label': open ? 'Close the folder' : 'Open the folder',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      },
    }, icon('chev', 12, 2.25));
    out.push(h('a', {
      class: 'row folder' + (open ? ' open' : '') + (current ? ' on' : ''),
      href: ctx.folderHref ? ctx.folderHref(dir.path) : null,
      style: { paddingLeft: `${10 + depth * (ctx.step || 16)}px` },
      role: 'treeitem',
      'aria-expanded': String(open),
      title: dir.path,
      onclick: ctx.folderHref
        ? () => {
          if (open && current) {
            ctx.open.delete(dir.path);
            renderMiddle();
          } else ctx.open.add(dir.path);
        }
        : toggle,
    }, chev, h('span', { class: 'folder-icon' }, icon('folder', 15)), h('span', { class: 'grow' }, name), h('span', { class: 'aside' }, dir.count)));
    if (open) treeRows(dir, depth + 1, ctx, out);
  }
  for (const f of sortedFiles(node)) {
    const name = baseName(f.path);
    const on = ctx.file === f.path;
    out.push(h('a', {
      class: 'row' + (on ? ' on' : ''),
      href: ctx.fileHref(f.path),
      style: { paddingLeft: `${32 + depth * (ctx.step || 16)}px` },
      role: 'treeitem',
      'aria-selected': String(on),
      title: ctx.tip ? ctx.tip(f) : f.path,
    },
    ctx.lead ? ctx.lead(f) : ctx.thumbs === false ? h('span', { class: 'kind' }, badge(name)) : fileThumb(f, name),
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
  const b = branchOf(t.id, r.repo, r.name);
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
  if (r.name && r.name !== repo.branch) facts.push(h('span', { title: `The task is on ${repo.branch} now` }, 'an earlier branch'));
  if (b.fetchedAt) facts.push(h('span', { title: b.fetchError || '' }, `${b.fetchError ? "couldn't fetch · " : 'fetched '}${clock(b.fetchedAt)}`));
  const card = h('div', { class: 'branch-card' },
    h('div', { class: 'top' }, h('span', { style: { color: 'var(--accent)', display: 'flex' } }, icon('branch', 16)), h('b', null, b.repo),
      h('span', { class: 'grow mono', style: { fontSize: '12.5px', color: 'var(--ink-2)' }, title: b.branch }, b.branch),
      b.links.branch ? tool('external', 'Open the branch on GitHub', null, { small: true, href: b.links.branch }) : null),
    facts.length ? h('div', { class: 'facts' }, facts) : null,
    b.missing ? h('div', { class: 'facts error' }, b.missing) : h('div', { class: 'from', title: b.clone }, `kept by yan branch · read from ${b.clone}`));
  if (b.missing) return { top: card, body: [] };

  const tabs = seg([['changes', `Changes ${b.files.length}`], ['commits', `Commits ${b.commits.length}`], ['files', 'All files']], r.tab, (tab) => {
    location.hash = inBranch(r, tab);
  }, true);
  const list = [];
  if (r.tab === 'commits') {
    for (const c of b.commits) {
      const on = (r.item || b.commits[0]?.sha) === c.sha;
      list.push(h('a', { class: 'commit-line' + (on ? ' on' : ''), href: inBranch(r, 'commits', c.sha) },
        h('span', { class: 'mono' }, short(c.sha)), h('span', { class: 'grow' }, c.subject), h('span', { class: 'aside' }, dayOf(c.at))));
    }
  } else if (r.tab === 'files') {
    const tree = S.branchTrees.get(b.head);
    if (!tree) {
      list.push(h('div', { class: 'sublabel' }, 'reading the files…'));
      void loadBranchTree(t.id, r.repo, b.head).then(() => {
        renderMiddle();
        renderRight(true);
      });
    } else {
      // Every folder starts closed, and the one holding the file asked for opens once.
      const key = `${t.id}:${r.repo}:${r.name || ''}:files`;
      if (!S.expanded.has(key)) S.expanded.set(key, new Set());
      const open = S.expanded.get(key);
      if (r.item && revealOnce(key, r.item)) for (let p = dirName(r.item); p; p = dirName(p)) open.add(p);
      treeRows(buildTree(tree), 0, {
        open,
        file: r.item || null,
        folder: null,
        thumbs: false,
        compact: true,
        step: 12,
        fileHref: (p) => inBranch(r, 'files', p),
      }, list);
    }
  } else {
    // Every folder starts open; one closed by hand stays closed until a file in it is asked for.
    const key = `${t.id}:${r.repo}:${r.name || ''}:changes`;
    if (!S.closed.has(key)) S.closed.set(key, new Set());
    const closed = S.closed.get(key);
    const cur = r.item || changeOrder(b)[0]?.path;
    if (cur && revealOnce(key, cur)) for (let p = dirName(cur); p; p = dirName(p)) closed.delete(p);
    treeRows(buildTree(b.files), 0, {
      open: { has: (p) => !closed.has(p), add: (p) => closed.delete(p), delete: (p) => closed.add(p) },
      file: cur,
      folder: null,
      compact: true,
      step: 12,
      fileHref: (p) => inBranch(r, 'changes', p),
      tip: (f) => (f.from ? `${f.from} → ${f.path}` : f.path),
      lead: (f) => h('span', { class: `status-letter ${f.status}`, title: STATUS_WORD[f.status] || '' }, f.status === 'M' ? '' : f.status),
      extra: (f) => (f.add === null ? h('span', { class: 'aside' }, 'binary') : [h('span', { class: 'plus' }, f.add ? `+${f.add}` : ''), h('span', { class: 'minus' }, f.del ? `−${f.del}` : '')]),
    }, list);
    if (!b.files.length) list.push(h('div', { class: 'sublabel' }, `No changes against ${b.target}.`));
  }
  return { top: h('div', { class: 'stack' }, card, tabs), body: h('div', { class: 'tree', role: 'tree' }, list) };
}
const STATUS_WORD = { A: 'added', D: 'deleted', R: 'renamed', M: 'changed', C: 'copied', T: 'type changed' };
S.closed = new Map();
const revealed = new Map();
/** True the first time `item` is asked for under `key`, so its folders open then and can be closed after. */
function revealOnce(key, item) {
  if (revealed.get(key) === item) return false;
  revealed.set(key, item);
  return true;
}
const changeOrders = new WeakMap();
/** A branch's changed files in the order its tree shows them, which prev and next walk. */
function changeOrder(b) {
  if (!changeOrders.has(b)) changeOrders.set(b, treeOrder(buildTree(b.files)));
  return changeOrders.get(b);
}
S.branchTrees = new Map();
async function loadBranchTree(id, repo, head) {
  if (S.branchTrees.has(head)) return;
  const files = await getJSON(`/api/branch/tree?task=${encodeURIComponent(id)}&repo=${repo}&head=${head}`);
  S.branchTrees.set(head, files);
}

// ── middle: Latest ──────────────────────────────────────────────────────────

/**
 * The pushes Latest lists: only what is new in its task since the last look.
 * A task opened during this visit keeps its pushes until the page moves away
 * from Latest, so the rest of what arrived with a file stays to be looked at.
 */
function unseenPushes() {
  return S.index.latest.filter((p) => p.at > (S.visit.get(p.task) ?? seenAt(p.task)));
}

function feedFiles() {
  const out = [];
  for (const p of unseenPushes()) for (const f of p.files) if (f.status !== 'D') out.push({ task: p.task, path: f.path, sha: f.sha, status: f.status, at: p.at });
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.task}/${f.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `+2 ~1 −1`: what a push added, changed and deleted, as tags. */
function pushTags(files) {
  const n = (st) => files.filter((f) => f.status === st).length;
  return [['A', 'new', '+', 'added'], ['M', 'changed', '~', 'changed'], ['D', 'gone', '−', 'deleted']]
    .filter(([st]) => n(st) > 0)
    .map(([st, cls, sign, word]) => h('span', { class: `tag ${cls}`, title: `${n(st)} ${word}` }, `${sign}${n(st)}`));
}

/**
 * Latest: what arrived and has not been looked at, newest first, a line a
 * push: when, which task, and how many files it added, changed and deleted.
 * Each opens to its files, and a file opens on the right. The push holding
 * the file being shown is open.
 */
function renderFeed() {
  const r = S.route;
  const heading = h('div', { class: 'section-head', style: { padding: '0 10px' } },
    h('h1', { style: { margin: 0, fontSize: '19px', lineHeight: '26px' } }, 'Latest'), h('span', { class: 'grow' }),
    h('button', { type: 'button', class: 'tool text', style: { height: '28px', color: 'var(--accent)', fontSize: '12.5px' }, onclick: markAllSeen }, 'Mark all seen'));
  const parts = [];
  const pushes = unseenPushes();
  if (!pushes.length) parts.push(h('div', { class: 'sublabel' }, S.index.latest.length ? 'Nothing new since you last looked.' : 'Nothing has arrived in any task’s artifacts yet.'));
  const showing = r.id ? pushes.find((p) => p.task === r.id && p.files.some((f) => f.path === r.path)) : undefined;
  let day = '';
  let group = null;
  for (const p of pushes) {
    const label = dayLabel(p.at);
    if (label !== day) {
      day = label;
      group = h('div', { class: 'group', style: { gap: '2px' } }, h('div', { class: 'feed-day' }, label));
      parts.push(group);
    }
    const key = `${p.task}@${p.at}`;
    const open = S.feedOpen.has(key) || p === showing;
    const t = S.byId.get(p.task);
    const head = h('button', { type: 'button', class: 'push-head' + (open ? ' open' : ''), 'aria-expanded': String(open), title: `${t?.title || p.task} · ${p.task}`,
      onclick: () => {
        if (open) S.feedOpen.delete(key);
        else S.feedOpen.add(key);
        if (p === showing && open) location.hash = '#/latest';
        else renderMiddle();
      } },
      h('span', { class: 'chev' }, icon('chev', 14)),
      h('b', null, clock(p.at)),
      h('span', { class: 'name' }, t?.title || p.task),
      h('span', { class: 'tags' }, pushTags(p.files)));
    const rows = !open ? [] : p.files.map((f) => {
      const name = baseName(f.path);
      const where = h('span', { class: 'grow' }, h('span', { class: 'dim' }, dirName(f.path) ? dirName(f.path) + '/' : ''), name);
      if (f.status === 'D') return h('div', { class: 'row gone', title: `${p.task}/${f.path}, deleted` }, h('span', { class: 'kind' }, badge(name)), where, h('span', { class: 'tag gone' }, 'deleted'));
      const on = r.id === p.task && r.path === f.path && p === showing;
      return h('a', { class: 'row' + (on ? ' on' : ''), href: link.latest(p.task, f.path), title: `${p.task}/${f.path}` },
        fileThumb(f, name), where, f.status === 'A' ? h('span', { class: 'tag new' }, 'new') : null);
    });
    group.append(h('div', { class: 'push' }, head, rows));
  }
  M.replaceChildren(...pane([heading], parts));
}
function markAllSeen() {
  for (const t of S.index.tasks) S.seen.tasks[t.id] = Math.max(seenAt(t.id), newestOf(t.id));
  S.visit.clear();
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
      const b = branchOf(r.id, r.repo, r.name);
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
    if (!r.id) return emptyRight('Latest', unseenPushes().length ? 'Open an update on the left, then one of its files, to see it here.' : 'When an agent pushes something new, it shows up here.');
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
  if (r.sub === 'report') return viewReport(t, d, token);
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
  const lang = langOf(name);
  Promise.all([textOf(url), langReady(lang)]).then(([text]) => {
    if (token !== S.rightToken) return;
    if (looksBinary(text)) {
      stage.classList.remove('top');
      stage.replaceChildren(binaryCard(name, url, size));
      return;
    }
    const body = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const lines = body.split('\n');
    if (meta) meta.textContent = `${KIND_LABEL[kindOf(name)].replace(/s$/, '')} · ${plural(lines.length, 'line')}${size != null ? ` · ${bytes(size)}` : ''}`;
    stage.replaceChildren(codeView(lines, wrap ?? WRAPPED.has(ext(name)), colourLines(lang, body)));
  }, (err) => stage.replaceChildren(h('div', { class: 'empty error' }, String(err.message || err))));
}

/** @param coloured the lines as HTML, from `colourLines`, or null for plain text. */
function codeView(lines, wrap, coloured) {
  const box = h('div', { class: 'code' + (wrap ? ' wrap' : '') });
  const LIMIT = 4000;
  const add = (from, to) => {
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.append(h('div', { class: 'ln' }, h('span', { class: 'n' }, i + 1), codeText({ t: lines[i], h: coloured ? coloured[i] : null })));
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
  colourBlocks(doc);
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
  const word = { open: ['teal', 'In progress'], uat: ['amber', '待验收'], done: ['green', 'Done'] }[t.state] || ['', 'Dropped'];
  pills.push(h('span', { class: `pill ${word[0]}` }, word[1]));
  const dates = [t.id, t.createdAt ? `started ${dayOf(fromIso(t.createdAt))}` : null, t.closedAt ? `${t.state === 'done' ? 'done' : 'closed'} ${dayOf(fromIso(t.closedAt))}` : null].filter(Boolean).join(' · ');
  pills.push(h('span', { class: 'pill' }, dates));
  d.repos.forEach((repo, i) => {
    if (repo.branch) pills.push(h('a', { class: 'pill', href: link.branch(t.id, i) }, icon('branch', 13), `${repo.name} · ${repo.branch}`));
    else pills.push(h('span', { class: 'pill' }, repo.name));
  });

  const paper = h('div', { class: 'paper' },
    h('header', { class: 'ov-head' }, h('div', { class: 'pills' }, pills), h('h2', null, t.title || t.id)));
  if (t.state === 'abandoned' && d.reason) paper.append(h('p', { class: 'notice' }, `Dropped: ${d.reason}`));
  if (t.state === 'uat') paper.append(uatBar(t));

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

/**
 * A task its agent has handed over to be checked. Accepting it is `yan done`,
 * at a terminal; not accepting it is this one click, which puts it back in
 * progress, committed and pushed, and tells the agent nothing.
 */
function uatBar(t) {
  const no = h('button', { type: 'button', class: 'button quiet', onclick: () => {
    no.disabled = true;
    postJSON('/api/not-accepted', { task: t.id }).then((out) => {
      toast(out.warning ? `已改回进行中，推送没成功：${out.warning}` : '已改回进行中');
      onStatus(out.status);
    }, (err) => {
      no.disabled = false;
      toast(`没改成：${err.message}`);
    });
  } }, '验收失败');
  return h('div', { class: 'uat-bar' }, h('span', { class: 'grow' }, '待验收：都做完了，等你来看。通过就在终端里 yan done。'), no);
}

// ── the report ──────────────────────────────────────────────────────────────
//
// artifacts/report.html, which the report skill writes, shown inside a
// shadow root so its style and the page's leave each other alone, with what
// serve adds on top: a deliverable is ticked, unticked or given up there and
// task.json changes; a text is edited there and report.html changes. Either
// is committed and pushed by the server, and arrives back as a new commit.
// Each deliverable is shown in the state task.json has now, not the one the
// page was written with.

const REPORT_PANEL_CSS = `
.yan-bar{position:sticky;top:0;z-index:2;background:#000;border-bottom:1px solid #262626}
.yan-bar-in{max-width:880px;margin:0 auto;padding:12px 24px;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px}
.yan-facts{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font-size:14px;color:#909090}
.yan-facts .file{font-family:ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,monospace;color:#fff}
.yan-said{color:#BCFF2F}.yan-said.bad{color:#FF8A8A}
.yan-legacy{position:relative;padding:2px 8px;border:none;border-radius:6px;background:#1F1F1F;color:#BCFF2F;font:12px ui-monospace,'SF Mono',Menlo,Consolas,monospace;cursor:help}
.yan-legacy .tip{display:none;position:absolute;left:0;top:calc(100% + 8px);z-index:3;min-width:260px;max-width:420px;padding:12px 14px;border-radius:10px;background:#121212;border:1px solid #3D3D3D;color:#DBDBDB;font:13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;text-align:left;white-space:normal}
.yan-legacy:hover .tip,.yan-legacy:focus .tip{display:block}
.yan-tip-head{color:#909090;margin-bottom:4px}
.yan-actions{display:flex;flex-wrap:wrap;gap:8px}
.yan-btn{display:inline-flex;align-items:center;min-height:40px;padding:0 14px;box-sizing:border-box;border:1px solid #383838;border-radius:999px;background:#000;color:#fff;font:inherit;font-size:14px;text-decoration:none;cursor:pointer}
.yan-btn:hover{border-color:#6C6C6C;color:#fff}
.yan-btn.main{border:none;background:#BCFF2F;color:#000;font-weight:500}
.yan-btn.main:disabled{background:#3D3D3D;color:#909090;cursor:default}
.yan-uat{max-width:880px;margin:0 auto;padding:4px 24px 12px;box-sizing:border-box}
.yan-uat-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px 14px;padding:8px 0;border-bottom:1px solid #1F1F1F;font-size:14px}
.yan-uat-row .p{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#fff;overflow-wrap:anywhere}
.yan-uat-row .w{grid-column:1/-1;color:#909090;font-size:13px}
.yan-uat-row a,.yan-uat-row button{color:#BDBDBD;font:inherit;font-size:13px;background:none;border:none;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.yan-tick{all:unset;flex:none;display:flex;padding:11px;margin:-7px -1px 0 -11px;cursor:pointer;border-radius:8px}
.yan-tick:focus-visible{outline:2px solid #BCFF2F}
.yan-tick .box{margin-top:0}
[data-yan-status="abandoned"] .yan-tick{cursor:default}
/* a report lays each deliverable out as a grid, its text under the box at full width: the button ends the first row */
.yan-side{flex:none;align-self:flex-start;grid-row:1;grid-column:3;min-height:36px;padding:0 12px;border:1px solid #383838;border-radius:999px;background:#000;color:#BDBDBD;font:inherit;font-size:13px;cursor:pointer}
.yan-side:hover{color:#fff;border-color:#6C6C6C}
[data-yan-edit]{border-radius:4px;outline:1px dashed transparent;outline-offset:4px;transition:outline-color .12s}
[data-yan-edit]:hover{outline-color:#3D3D3D}
[data-yan-edit]:focus{outline:1px solid #BCFF2F}
.yan-video{display:flex;flex-direction:column;gap:10px}
.yan-video video{display:block;width:100%;border-radius:14px;border:1px solid #262626;background:#121212}
.yan-video .row{display:flex;align-items:center;gap:12px;font:13px ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#909090}
.yan-report figure img{cursor:zoom-in}
.yan-zoom{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:56px 72px;background:rgba(0,0,0,.78);outline:none}
.yan-zoom img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.6)}
.yan-zoom .yan-zoom-close{position:fixed;top:16px;right:16px;display:flex;padding:10px;border:1px solid #383838;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;cursor:pointer}
.yan-zoom .yan-zoom-close:hover{border-color:#6C6C6C}
.yan-zoom .yan-zoom-n{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:4px 12px;border-radius:999px;background:rgba(0,0,0,.6);color:#BDBDBD;font:13px ui-monospace,'SF Mono',Menlo,Consolas,monospace}
.yan-zoom .yan-zoom-n:empty{display:none}
.yan-modal{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px}
.yan-dialog{width:100%;max-width:440px;box-sizing:border-box;padding:24px;border-radius:16px;background:#121212;border:1px solid #262626;display:flex;flex-direction:column;gap:18px}
.yan-dialog .t{font-size:18px;font-weight:700;line-height:1.4;color:#fff}
.yan-dialog .s{font-size:14px;line-height:1.6;color:#909090}
.yan-dialog input{min-height:44px;padding:0 12px;border:1px solid #3D3D3D;border-radius:8px;background:#000;color:#fff;font:inherit;font-size:15px}
.yan-dialog .b{display:flex;justify-content:flex-end;gap:8px}
`;

/** Last words said on a task's report, so a redraw for the commit they caused keeps them a moment. */
const reportSaid = new Map();

function sayOnReport(id, text, bad) {
  reportSaid.set(id, { text, bad: !!bad, at: Date.now() });
  const el = R.querySelector('.report-host')?.shadowRoot?.querySelector('.yan-said');
  if (el) {
    el.textContent = text;
    el.classList.toggle('bad', !!bad);
  }
}

async function postJSON(url, value) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const text = await r.text();
  if (!r.ok) throw new Error(text || `${r.status}`);
  return JSON.parse(text);
}

/** The page's own nodes with nothing that runs: no scripts, frames or handlers, links only to the web or to pictures inside. */
function cleanReport(doc) {
  doc.querySelectorAll('script,iframe,frame,object,embed,link,meta,base,form,style,noscript,template').forEach((el) => el.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') el.removeAttribute(a.name);
      else if (name === 'href' || name === 'src' || name === 'xlink:href') {
        const v = a.value.trim();
        const ok = name === 'href' ? /^(https?:|#)/i.test(v) : /^(https?:|data:image\/(png|jpe?g|gif|webp);)/i.test(v);
        if (!ok) el.removeAttribute(a.name);
      }
    }
  }
  return doc;
}

function viewReport(t, d, token) {
  keyNav = { prev: null, next: null };
  const before = R.querySelector('.report-host');
  const keep = before && before.dataset.task === t.id ? R.querySelector('.scroll')?.scrollTop || 0 : 0;
  getJSON(`/api/report?task=${encodeURIComponent(t.id)}`).then((rep) => {
    if (token !== S.rightToken) return;
    drawReport(t, d, rep);
    const scroller = R.querySelector('.scroll');
    if (scroller) scroller.scrollTop = keep;
  }, (err) => {
    if (token === S.rightToken) emptyRight('No report', String(err.message || err));
  });
  if (!before || before.dataset.task !== t.id) emptyRight('Loading…');
}

function drawReport(t, d, rep) {
  const doc = cleanReport(new DOMParser().parseFromString(rep.html, 'text/html'));
  const style = [...new DOMParser().parseFromString(rep.html, 'text/html').querySelectorAll('style')]
    .map((x) => x.textContent).join('\n')
    .replace(/:root\s*\{/g, ':host{').replace(/(^|[}\s,])body\s*\{/g, '$1.yan-report{');
  const host = h('div', { class: 'report-host', 'data-task': t.id });
  const root = host.attachShadow({ mode: 'open' });
  const live = new Map(d.deliverables.map((x) => [x.id, x]));
  const said = reportSaid.get(t.id);
  const saidNow = said && Date.now() - said.at < 5000 ? said : null;

  // the bar: what the page is, how far behind, and what to take away
  const generated = rep.generatedAt ? `生成于 ${dayOf(fromIso(rep.generatedAt))} ${clock(fromIso(rep.generatedAt))}` : null;
  const legacy = rep.behind.length === 0 ? null : h('button', { type: 'button', class: 'yan-legacy', 'aria-label': `legacy: ${rep.behind.join('; ')}` }, 'legacy',
    h('span', { class: 'tip' }, h('div', { class: 'yan-tip-head' }, '报告生成之后：'), rep.behind.map((line) => h('div', null, line)), h('div', { class: 'yan-tip-head', style: { marginTop: '6px' } }, '重跑 /report 更新它')));
  const uatList = h('div', { class: 'yan-uat', hidden: true }, rep.uat.length === 0 ? h('div', { class: 'yan-uat-row' }, h('span', { class: 'w' }, 'uat/ 里还没有素材')) : rep.uat.map((f) => {
    const isVideo = VIDEO.has(ext(f.path));
    return h('div', { class: 'yan-uat-row' },
      h('span', { class: 'p' }, f.path),
      isVideo && f.url ? h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(f.url).then(() => toast('链接已复制')) }, '复制链接') : h('span'),
      h('a', { href: `${fileUrl(vaultPath(t.id, 'uat/' + f.path))}?download` }, '下载'),
      h('span', { class: 'w' }, f.for.length ? `${f.for.join('、')} · ${f.shows}` : '没有用 yan uat 登记'));
  }));
  const bar = h('div', { class: 'yan-bar' }, h('div', { class: 'yan-bar-in' },
    h('div', { class: 'yan-facts' }, h('span', { class: 'file' }, 'report.html'), generated ? h('span', null, generated) : null, legacy,
      h('span', { class: 'yan-said' + (saidNow?.bad ? ' bad' : '') }, saidNow?.text || '')),
    h('div', { class: 'yan-actions' },
      h('button', { type: 'button', class: 'yan-btn', 'aria-expanded': 'false', onclick: (e) => {
        uatList.hidden = !uatList.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!uatList.hidden));
      } }, `uat 素材 ${rep.uat.length}`),
      h('a', { class: 'yan-btn main', href: `/api/report/download?task=${encodeURIComponent(t.id)}` }, '下载 HTML'))), uatList);

  const shell = h('div', { class: 'yan-report' }, bar, ...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  root.append(h('style', null, `${style}\n${REPORT_PANEL_CSS}`), shell);

  // the deliverables: ticked, unticked and given up here, shown as task.json has them now.
  // A click shows its result at once, counts included: the page is drawn again only once
  // the vault is committed and pushed, which can take seconds.
  const state = new Map(d.deliverables.map((x) => [x.id, x.status]));
  const progress = shell.querySelector('[data-yan-progress]');
  const recount = () => {
    const all = [...state.values()];
    const count = (st) => all.filter((s) => s === st).length;
    const pct = (n) => `${all.length ? (n / all.length) * 100 : 0}%`;
    if (progress) progress.textContent = `${count('done')} 完成 · ${count('todo')} 待确认 · ${count('abandoned')} 放弃`;
    shell.querySelector('[data-yan-bar="done"]')?.style.setProperty('width', pct(count('done')));
    shell.querySelector('[data-yan-bar="abandoned"]')?.style.setProperty('width', pct(count('abandoned')));
  };
  const show = (el, id, status, reason) => {
    el.dataset.yanStatus = status;
    const why = el.querySelector('[data-yan-reason]');
    if (why) why.textContent = status === 'abandoned' ? reason || '' : '';
    const tick = el.querySelector('.yan-tick');
    if (tick) {
      tick.setAttribute('aria-label', status === 'done' ? `${id} 标回待确认` : `${id} 标为完成`);
      tick.disabled = status === 'abandoned';
    }
    const side = el.querySelector('.yan-side');
    if (side) side.textContent = status === 'abandoned' ? '恢复' : '放弃';
  };
  const send = (id, to, reason) => {
    state.set(id, to);
    for (const el of shell.querySelectorAll(`[data-yan-d="${CSS.escape(id)}"]`)) show(el, id, to, reason);
    recount();
    postJSON('/api/deliverable', { task: t.id, id, to, reason }).then((out) => {
      sayOnReport(t.id, out.warning ? `已写回，推送没成功：${out.warning}` : `已写回 ${t.id} 的 deliverables`, !!out.warning);
      onStatus(out.status);
    }, (err) => {
      sayOnReport(t.id, `没写进去：${err.message}`, true);
      loadTask(t.id, true).then(render);
    });
  };
  for (const el of shell.querySelectorAll('[data-yan-d]')) {
    const id = el.dataset.yanD;
    const now = live.get(id);
    if (!now) continue;
    const box = el.querySelector('.box');
    const name = (el.querySelector('[data-yan-edit="summary"]') || el.querySelector('[data-yan-edit="text"]'))?.textContent || id;
    if (box) {
      const tick = h('button', { type: 'button', class: 'yan-tick', onclick: () => send(id, el.dataset.yanStatus === 'done' ? 'todo' : 'done') });
      box.replaceWith(tick);
      tick.append(box);
    }
    el.append(h('button', { type: 'button', class: 'yan-side',
      onclick: () => (el.dataset.yanStatus === 'abandoned' ? send(id, 'todo') : askReason(root, id, name, (reason) => send(id, 'abandoned', reason))) }));
    show(el, id, now.status, now.reason);
  }
  recount();

  // the texts: edited in place, saved to report.html when left
  shell.querySelectorAll('[data-yan-edit]').forEach((el, index) => {
    el.setAttribute('contenteditable', 'plaintext-only');
    el.setAttribute('spellcheck', 'false');
    let was = el.textContent;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') { el.textContent = was; el.blur(); }
    });
    el.addEventListener('blur', () => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text === was.trim()) return;
      if (text === '') { el.textContent = was; return; }
      was = text;
      postJSON('/api/report/edit', { task: t.id, sha: rep.sha, index, text }).then((out) => {
        sayOnReport(t.id, out.warning ? `已保存，推送没成功：${out.warning}` : '已保存到 report.html', !!out.warning);
        onStatus(out.status);
      }, (err) => sayOnReport(t.id, `没保存：${err.message}`, true));
    });
  });

  // the pictures: one clicked fills the screen
  const shots = [...shell.querySelectorAll('figure img')];
  shots.forEach((img, i) => img.addEventListener('click', () => zoomShot(root, shots, i)));

  // the recordings: played here, their link to copy
  for (const line of shell.querySelectorAll('[data-yan-video]')) {
    const path = line.dataset.yanVideo;
    const info = rep.uat.find((f) => f.path === path);
    line.replaceWith(h('div', { class: 'yan-video' },
      h('video', { controls: true, preload: 'metadata', src: fileUrl(vaultPath(t.id, 'uat/' + path)) }),
      h('div', { class: 'row' }, h('span', null, path),
        info?.url ? h('button', { type: 'button', class: 'yan-btn', style: { minHeight: '32px' }, onclick: () => navigator.clipboard.writeText(info.url).then(() => toast('链接已复制')) }, '复制链接') : null)));
  }

  R.replaceChildren(h('div', { class: 'scroll', style: { background: '#000' } }, host));
}

/**
 * A picture of the report large, in a modal over the page: fitted to the
 * window with a margin round it, the page dimmed behind. ← and → go through
 * the report's other pictures; Esc, ✕ or a click beside the picture closes it.
 */
function zoomShot(root, shots, at) {
  const img = h('img', { alt: '' });
  const n = h('span', { class: 'yan-zoom-n' });
  const close = () => view.remove();
  const view = h('div', { class: 'yan-zoom', tabindex: '-1', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === view) close(); } },
    img, n, h('button', { type: 'button', class: 'yan-zoom-close', 'aria-label': '关闭', onclick: close }, icon('close', 18)));
  const show = (i) => {
    at = (i + shots.length) % shots.length;
    img.src = shots[at].src;
    img.alt = shots[at].alt;
    n.textContent = shots.length > 1 ? `${at + 1} / ${shots.length}` : '';
  };
  view.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && shots.length > 1) show(at - 1);
    else if (e.key === 'ArrowRight' && shots.length > 1) show(at + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  root.querySelector('.yan-report').append(view);
  show(at);
  view.focus();
}

/** The pop-up for giving a deliverable up: a reason is needed, since `yan deliverable abandon` keeps it. */
function askReason(root, id, name, then) {
  const input = h('input', { 'aria-label': '放弃的原因', placeholder: '' });
  const ok = h('button', { type: 'button', class: 'yan-btn main', disabled: true }, '放弃');
  const close = () => modal.remove();
  const modal = h('div', { class: 'yan-modal', onclick: (e) => { if (e.target === modal) close(); } },
    h('div', { class: 'yan-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': `放弃 ${id}` },
      h('div', null, h('div', { class: 't' }, `放弃 ${id.slice(1)}. ${name}？`), h('div', { class: 's' }, '写一句原因，以后不会再被提起')),
      input,
      h('div', { class: 'b' }, h('button', { type: 'button', class: 'yan-btn', onclick: close }, '取消'), ok)));
  input.addEventListener('input', () => { ok.disabled = input.value.trim() === ''; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && input.value.trim() !== '') ok.click();
  });
  ok.addEventListener('click', () => {
    const reason = input.value.trim();
    if (reason === '') return;
    close();
    then(reason);
  });
  root.querySelector('.yan-report').append(modal);
  input.focus();
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
        rows.push(h('div', { class: `dl ${l.k}` }, h('span', { class: 'a' }, l.a ?? ''), h('span', { class: 'b' }, l.b ?? ''), h('span', { class: 's' }, l.k === 'add' ? '+' : l.k === 'del' ? '−' : ''), codeText(l)));
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
  return h('div', { class: 'half' + cls }, h('span', { class: 'a' }, side === 'a' ? l.a ?? '' : l.b ?? ''), codeText(l));
}

function viewBranch(t, r, token) {
  keyNav = { prev: null, next: null };
  const b = branchOf(t.id, r.repo, r.name);
  if (!b) return emptyRight('Reading the branch…');
  if (b.missing) return emptyRight('Nothing to show', b.missing);
  const github = b.links.branch ? b.links.branch.replace(/\/tree\/.*$/, '') : null;

  if (r.tab === 'commits') {
    const sha = r.item || b.commits[0]?.sha;
    const at = b.commits.findIndex((c) => c.sha === sha);
    if (!sha) return emptyRight('No commits', `${b.branch} has nothing ${b.target} does not.`);
    keyNav = {
      prev: at > 0 ? inBranch(r, 'commits', b.commits[at - 1].sha) : null,
      next: at >= 0 && at < b.commits.length - 1 ? inBranch(r, 'commits', b.commits[at + 1].sha) : null,
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
    getJSON(`/api/branch/commit?task=${encodeURIComponent(t.id)}&repo=${r.repo}&sha=${sha}`).then(async (full) => {
      const files = parsePatch(full.patch);
      await Promise.all(files.map((x) => langReady(langOf(x.path))));
      if (token !== S.rightToken) return;
      for (const x of files) colourPatch(x, langOf(x.path));
      scroll.replaceChildren();
      append(scroll, [
        full.body ? h('div', { class: 'commit-body' }, full.body) : null,
        full.truncated ? h('div', { class: 'notice' }, 'This commit is too big to show whole; it is cut short.') : null,
        files.map((f) => h('div', { class: 'diff' }, h('div', { class: 'diff-file-head' }, h('a', { href: inBranch(r, 'changes', f.path) }, f.path), f.note.length ? h('span', { class: 'dim' }, f.note.join(', ')) : null), diffBody(f, S.prefs.layout)))]);
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
  const order = changeOrder(b);
  const path = r.item || order[0]?.path;
  if (!path) return emptyRight('No changes', `${b.branch} changes nothing against ${b.target}.`);
  const at = order.findIndex((f) => f.path === path);
  const f = order[at];
  if (!f) return emptyRight('Not in this branch', `${path} is not among the files ${b.branch} changes.`);
  keyNav = {
    prev: at > 0 ? inBranch(r, 'changes', order[at - 1].path) : null,
    next: at < order.length - 1 ? inBranch(r, 'changes', order[at + 1].path) : null,
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
  const lang = langOf(f.path);
  // The diff with the whole file as context is fetched too, for the colours
  // alone: coloured entire, a comment or string a hunk starts inside is right.
  const whole = S.prefs.whole || !lang ? null : textOf(`/api/branch/diff?${new URLSearchParams({ ...Object.fromEntries(q), context: 'all' })}`).catch(() => null);
  Promise.all([textOf(`/api/branch/diff?${q}`), whole, langReady(lang)]).then(([patch, wholePatch]) => {
    if (token !== S.rightToken) return;
    const files = parsePatch(patch);
    const one = files[0] || { hunks: [], binary: f.add === null, note: [] };
    colourPatch(one, lang, wholePatch ? parsePatch(wholePatch)[0] : S.prefs.whole ? one : null);
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
  if (before.view === 'latest' && r.view !== 'latest') S.visit.clear();
  if (!S.index) return;

  if (r.view === 'task' && S.byId.has(r.id)) {
    S.last.set(r.id, location.hash);
    markTaskSeen(r.id);
    const need = [];
    if (!detailOf(r.id) || S.tasks.get(r.id).version !== S.version) need.push(loadTask(r.id));
    if (r.sub === 'branch' && !branchOf(r.id, r.repo, r.name)) need.push(loadBranch(r.id, r.repo, r.name).catch(() => undefined));
    if (r.sub === 'branch') loadEarlier(r.id, r.repo);
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
    if (r.id) markTaskSeen(r.id);
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
