#!/usr/bin/env node
/**
 * Render a yan task's report: artifacts/report.html and artifacts/report.json.
 *
 *   node render.mjs <content.json> [--task <id>]
 *
 * content.json is the only part the agent writes:
 *
 *   { "title": "df blade app",
 *     "problem": "one paragraph",
 *     "approach": ["a point of how it was solved", ...],
 *     "summaries": { "d1": "a few words", ... } }
 *
 * The problem is followed by a fixed sentence, 解决以下问题，我们采用如下方案：,
 * and the approach as a numbered list under it.
 *
 * A summary is wanted for each deliverable not given up: it is the
 * deliverable's heading, pictures or not. Those given up are listed by
 * their own text. "texts", optional, gives a
 * deliverable's text in the report's language when it was written in
 * another: { "d1": "…" }; "reasons", optional, does the same for why one
 * was given up. How a deliverable with nothing to show was checked, the
 * note `yan uat note` keeps, is left off the page: it reports what was
 * delivered, and the user reads the notes in yan.
 *
 * Everything else comes from `yan context --json`: the deliverables and their
 * state, the resources, and artifacts/uat/uat.json, which says which file
 * shows which deliverable. Every deliverable not given up gets a block under
 * DELIVERABLES, in the order of their ids, with its files under it when it
 * has any; deliverables shown by exactly the same files share one, placed
 * where the first of them comes. The ones given up are listed last, under
 * ABANDONED DELIVERABLES. Each part numbers its deliverables by place, from
 * 1, and ends each with its id, (d3): a reader sees a list with no gaps,
 * and the id ties a line back to yan. Images are put inside
 * the page as base64, so it can be dragged into a document as one file;
 * recordings are links to the vault's repository, which is where a document
 * can open them.
 *
 * report.json records what the page was made from, the deliverables as they
 * were and a hash of every file uat.json named, so `yan serve` can tell when
 * the page is behind.
 *
 * The page is the read-only one. For `yan serve` to add checking, giving up
 * and editing on top of it, a deliverable's element carries data-yan-d (its
 * id) and data-yan-status, a recording's line data-yan-video (its path in
 * uat/), its reason for being given up sits in
 * data-yan-reason, the counts in data-yan-progress and data-yan-bar, its
 * number in data-yan-n, and each text that can be edited in a data-yan-edit
 * (title, problem, approach, summary, text) holding nothing but the text.
 *
 * The copy `yan serve` hands out leaves the deliverables given up out, since
 * it reports what was delivered. Each part of the page that is there only
 * for its deliverables, a block and each list with its heading, is marked
 * data-yan-group, and goes when none is left in it; the numbers left are
 * counted from 1 again under each heading, so one given up on the page after
 * it was written leaves no gap.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
// The resources a report names, by kind. A merge request is left out: the report goes to readers who
// look at what was delivered, not at the code review it went through.
const KIND_LABELS = { spec: '需求', preview: '测试链接', run: '子任务' };

function die(message) {
  process.stderr.write(`render: ${message}\n`);
  process.exit(1);
}

function args() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--task');
  const task = at === -1 ? undefined : argv[at + 1];
  const rest = at === -1 ? argv : argv.filter((_, i) => i !== at && i !== at + 1);
  if (rest.length !== 1) die('usage: node render.mjs <content.json> [--task <id>]');
  return { content: rest[0], task };
}

/** `yan context --json`; on Windows yan is a .cmd shim, which only a shell runs. */
function context(task) {
  const r = spawnSync('yan', ['context', '--json', ...(task === undefined ? [] : ['--task', task])], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) die(`yan context failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return JSON.parse(r.stdout);
}

/** m:ss, from ffprobe when it is installed; '' otherwise. */
function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', shell: process.platform === 'win32' });
  const seconds = Number((r.stdout ?? '').trim());
  if (r.status !== 0 || !Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isUrl = (s) => /^https?:\/\//i.test(s);

/** 2026-10-15 → 10-16, from when the task was made to when it closed or today. */
function dates(ctx) {
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('sv-SE') : new Date().toLocaleDateString('sv-SE'));
  const from = ctx.createdAt ? day(ctx.createdAt) : undefined;
  const to = day(ctx.closedAt);
  if (from === undefined || from === to) return to;
  return `${from} → ${from.slice(0, 4) === to.slice(0, 4) ? to.slice(5) : to}`;
}

/** Before, then after, then new and other images, then recordings, the order `cells` pairs them from. */
function order(files) {
  const rank = (f) => (f.isImage ? (f.side === 'before' ? 0 : f.side === 'after' ? 1 : 2) : 3);
  return [...files].sort((a, b) => rank(a) - rank(b));
}

/** A block per deliverable not given up, those shown by the same files sharing one; and the ones given up. */
function blocksOf(ctx, uatDir) {
  const open = ctx.deliverables.filter((d) => d.status !== 'abandoned');
  const linkOf = new Map(ctx.artifacts.map((a) => [a.path, a.url]));
  const filesFor = (id) => ctx.uat.files
    .filter((f) => f.for.includes(id) && existsSync(join(uatDir, f.path)))
    .map((f) => ({ ...f, isImage: extname(f.path).toLowerCase() in IMAGE_TYPES }));
  const blocks = [];
  for (const d of open) {
    const files = filesFor(d.id);
    const key = files.map((f) => f.path).sort().join('\n');
    // Having no files in common is not sharing them: each of those stands alone.
    const same = files.length === 0 ? undefined : blocks.find((b) => b.key === key);
    if (same !== undefined) same.ds.push(d);
    else blocks.push({ key, ds: [d], files: order(files).map((f) => ({ ...f, url: linkOf.get(`uat/${f.path}`) ?? null })) });
  }
  return { blocks, abandoned: ctx.deliverables.filter((d) => d.status === 'abandoned') };
}

const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * A deliverable's state is one attribute, data-yan-status, and the style
 * draws everything from it: the box and its tick, the badge, the strike and
 * the reason it was given up. `yan serve` changes the attribute alone to
 * show the state as it is now, and to hand out a copy that says so.
 *
 * The box and the heading share the first row; under a heading the text
 * and the reason run the page's full width, from the box's left edge, as
 * the pictures do. In the list of those given up, where a line has no
 * pictures to line up with, the reason starts where the line's text does.
 */
function why(d, reason) {
  return `<p class="why">放弃：<span data-yan-reason="">${esc(d.status === 'abandoned' ? reason : '')}</span></p>`;
}

/** The number a deliverable has on the page, which `yan serve` counts again in the copy it hands out. */
const number = (n) => `<span data-yan-n="">${n}. </span>`;
/** Which deliverable it is in yan, after its heading or line. */
const idOf = (d) => `<span class="id">（${esc(d.id)}）</span>`;

function head(d, n, summary, text, reason) {
  return `<div class="head" data-yan-d="${esc(d.id)}" data-yan-status="${esc(d.status)}">
<span class="box">${CHECK}</span>
<div class="words">
<div class="line"><h3>${number(n)}<span data-yan-edit="summary">${esc(summary)}</span>${idOf(d)}</h3><span class="badge"></span></div>
<p class="text" data-yan-edit="text">${esc(text)}</p>
${why(d, reason)}
</div>
</div>`;
}

/**
 * Where each picture goes. With a before among them, it is two columns, a
 * row a pair: each before on the left and its after beside it, so two pairs
 * read 前后 / 前后 and never 前前 / 后后. A before's after is the one named
 * like it (d2-before.png, d2-after.png), else the next one not yet paired;
 * a before with none keeps its row to itself, and the pictures left over
 * follow. Without one, a lone picture takes the width and three share a row.
 * A null is a cell left empty.
 */
function cells(images) {
  const befores = images.filter((f) => f.side === 'before');
  if (befores.length === 0) return { columns: images.length === 1 ? 1 : images.length === 3 ? 3 : 2, cells: images };
  const rest = images.filter((f) => f.side !== 'before');
  const key = (f) => f.path.replace(/\.[^.]+$/, '').replace(/before|after/gi, '');
  const pairs = new Map();
  const free = (f) => f.side === 'after' && ![...pairs.values()].includes(f);
  for (const b of befores) {
    const a = rest.find((f) => free(f) && key(f) === key(b));
    if (a !== undefined) pairs.set(b, a);
  }
  for (const b of befores) {
    const a = pairs.has(b) ? undefined : rest.find(free);
    if (a !== undefined) pairs.set(b, a);
  }
  const paired = [...pairs.values()];
  return { columns: 2, cells: [...befores.flatMap((b) => [b, pairs.get(b) ?? null]), ...rest.filter((f) => !paired.includes(f))] };
}

/** The label in a picture's corner, by the side `yan uat add` recorded: a pair's halves, or something new. */
const TAGS = {
  before: '<span class="tag before">改前</span>',
  after: '<span class="tag after">改后</span>',
  new: '<span class="tag new">新增</span>',
};

function media(block, uatDir) {
  const images = block.files.filter((f) => f.isImage);
  const videos = block.files.filter((f) => !f.isImage);
  const { columns, cells: placed } = cells(images);
  const grid = images.length === 0 ? '' : `<div class="grid" style="grid-template-columns: repeat(${columns}, minmax(0, 1fr))">
${placed.map((f) => {
    if (f === null) return '<div></div>';
    const file = join(uatDir, f.path);
    const data = readFileSync(file).toString('base64');
    const tag = TAGS[f.side] ?? '';
    return `<figure>${tag}<img src="data:${IMAGE_TYPES[extname(f.path).toLowerCase()]};base64,${data}" alt="${esc(f.shows)}"></figure>`;
  }).join('\n')}
</div>`;
  const links = videos.map((f) => {
    const length = duration(join(uatDir, f.path));
    const name = `<span class="name">${esc(f.path)}</span>${length === '' ? '' : `<span class="length">${length}</span>`}`;
    const play = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="#BCFF2F"/></svg>';
    // Only a web address is linked: the address comes from the vault's config, and another scheme could run.
    return f.url === null || !isUrl(f.url)
      ? `<p class="video" data-yan-video="${esc(f.path)}">${play}${name}</p>`
      : `<p class="video" data-yan-video="${esc(f.path)}"><a href="${esc(f.url)}">${play}${name}</a></p>`;
  }).join('\n');
  return [grid, links].filter((s) => s !== '').join('\n');
}

function properties(ctx) {
  const all = ctx.deliverables;
  const count = (s) => all.filter((d) => d.status === s).length;
  const [done, todo, gone] = [count('done'), count('todo'), count('abandoned')];
  const pct = (n) => (all.length === 0 ? 0 : (n / all.length) * 100).toFixed(2);
  const rows = [
    ['进度', `<span class="bar"><span data-yan-bar="done" style="width:${pct(done)}%"></span><span data-yan-bar="abandoned" style="width:${pct(gone)}%"></span></span><span data-yan-progress="">${done} 完成 · ${todo} 待确认 · ${gone} 放弃</span>`],
    ['日期', `<span class="mono">${esc(dates(ctx))}</span>`],
  ];
  for (const [kind, label] of Object.entries(KIND_LABELS)) {
    const kept = ctx.resources.filter((r) => r.kind === kind);
    if (kept.length === 0) continue;
    rows.push([label, kept.map((r) => (isUrl(r.where) ? `<a href="${esc(r.where)}">${esc(r.name)}</a>` : esc(r.name))).join('')]);
  }
  return `<dl class="props">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/**
 * The page is drawn in 寒蝉全圆体 (ChillRoundF), linked from jsDelivr as the
 * web font @chinese-fonts/hcqyt cut it: some 170 files a weight, each with
 * its unicode-range, so a reader's browser fetches only the few that hold
 * the characters on the page. Its bold is a family of its own, which the
 * bold headings name first.
 *
 * yan serve shows the page in a shadow root and takes only its <style>,
 * where Chrome ignores @font-face anyway; there the page falls through to
 * Yan Round, the subset of the same face yan serve declares for itself, and
 * fetches nothing. Offline, it falls through to the system's sans-serif.
 */
const FONT_LINKS = ['ChillRoundFRegular', 'ChillRoundFBold']
  .map((w) => `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@chinese-fonts/hcqyt@2.0.0/dist/${w}/result.css">`)
  .join('\n');
const SYSTEM_FACE = `-apple-system,BlinkMacSystemFont,'Segoe UI Variable Text','Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei UI','Microsoft YaHei','Noto Sans CJK SC',sans-serif`;
const FACE = `'寒蝉全圆体','Yan Round',${SYSTEM_FACE}`;
const BOLD_FACE = `'寒蝉全圆体 Bold',${FACE}`;

const STYLE = `
:root{color-scheme:dark}
body{margin:0;background:#000;color:#fff;font-family:${FACE}}
a{color:#fff}a:hover{color:#BCFF2F}
.mono,.video{font-family:ui-monospace,'SF Mono','Cascadia Mono',Menlo,Consolas,monospace}
.cover{height:120px;background:#121212;border-bottom:1px solid #262626}
.page{max-width:880px;margin:0 auto;padding:0 24px 120px;box-sizing:border-box}
.icon{width:80px;height:80px;margin-top:-40px;box-sizing:border-box;border-radius:18px;background:#1F1F1F;border:1px solid #3D3D3D;display:flex;align-items:center;justify-content:center}
h1{margin:22px 0 0;font-size:40px;line-height:1.2;font-weight:700;letter-spacing:-.01em;font-family:${BOLD_FACE}}
.props{margin:22px 0 0;display:grid;grid-template-columns:minmax(0,120px) minmax(0,1fr);gap:0 16px;font-size:15px;border-top:1px solid #262626;padding-top:10px}
.props dt{padding:9px 0;color:#909090}
.props dd{margin:0;padding:9px 0;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
.bar{display:flex;width:180px;height:8px;border-radius:4px;overflow:hidden;background:#262626}
h2{margin:80px 0 0;font-size:14px;font-weight:500;letter-spacing:.08em;color:#909090}
.problem{margin:20px 0 0;font-size:16px;line-height:1.85;color:#DBDBDB}
ol.approach{margin:6px 0 0;padding-left:1.6em;list-style:decimal;font-size:16px;line-height:1.85;color:#DBDBDB}
.approach li{padding-left:4px}
.approach li::marker{color:#909090;font-variant-numeric:tabular-nums}
section{padding:48px 0 8px;display:flex;flex-direction:column;gap:20px}
.heads{display:flex;flex-direction:column;gap:18px}
.head{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;align-items:start}
.words{display:contents}
.line,.item{grid-column:2}
.text,.why{grid-column:1/-1}
li.head .why{grid-column:2}
.line{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
h3{margin:0;font-size:22px;line-height:1.4;font-weight:700;font-family:${BOLD_FACE}}
.id{font-weight:400;font-family:${FACE};color:#909090}
.text{margin:0;font-size:15px;line-height:1.75;color:#BDBDBD}
[data-yan-status="abandoned"] h3,[data-yan-status="abandoned"] .text,[data-yan-status="abandoned"] .item{color:#6C6C6C;text-decoration:line-through}
.why{margin:2px 0 0;font-size:14px;line-height:1.7;color:#BDBDBD}
.why{display:none}
[data-yan-status="abandoned"] .why{display:block}
.box{flex:none;width:22px;height:22px;margin-top:4px;box-sizing:border-box;border-radius:6px;border:1.5px solid #fff;display:flex;align-items:center;justify-content:center}
.box svg{display:none}
[data-yan-status="done"] .box{background:#BCFF2F;border-color:#BCFF2F}
[data-yan-status="done"] .box svg{display:block}
[data-yan-status="abandoned"] .box{border-color:#3D3D3D}
.badge{padding:1px 8px;border-radius:6px;font-size:13px}
.badge:empty{display:none}
[data-yan-status="done"] .badge{display:inline;background:#BCFF2F;color:#000;font-weight:500}
[data-yan-status="done"] .badge::after{content:"完成"}
[data-yan-status="todo"] .badge{display:inline;border:1px solid #fff;color:#fff}
[data-yan-status="todo"] .badge::after{content:"待确认"}
[data-yan-bar="done"]{background:#BCFF2F}
[data-yan-bar="abandoned"]{background:#6C6C6C}
.grid{display:grid;gap:14px;align-items:start}
figure{position:relative;margin:0;min-width:0}
figure img{display:block;width:100%;border-radius:14px;border:1px solid #262626;box-sizing:border-box}
.tag{position:absolute;left:12px;top:12px;padding:2px 10px;border-radius:6px;font-size:13px}
.tag.before{background:#fff;color:#000}
.tag.after{background:#BCFF2F;color:#000;font-weight:500}
.tag.new{background:#FFD60A;color:#000;font-weight:500}
.video{margin:0;font-size:15px}
.video{display:flex;align-items:center;gap:8px;color:#BCFF2F}
.video a{display:inline-flex;align-items:center;gap:8px;color:#BCFF2F;text-decoration:none}
.video .name{text-decoration:underline;text-underline-offset:3px}
.video .length{margin-left:4px;color:#909090}
ol{margin:8px 0 0;padding:0;list-style:none}
ol .head{padding:10px 0}
.item{font-size:16px;line-height:1.6}
`;

const ICON = '<svg width="44" height="44" viewBox="0 0 48 48" aria-hidden="true"><path d="M10 25.5l9 9L38.5 14" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function page(ctx, content, uatDir) {
  const { blocks, abandoned } = blocksOf(ctx, uatDir);
  const summary = (d) => content.summaries[d.id];
  const given = (map, id) => (typeof map?.[id] === 'string' && map[id].trim() !== '' ? map[id] : undefined);
  const text = (d) => given(content.texts, d.id) ?? d.text;
  const reason = (d) => given(content.reasons, d.id) ?? d.reason ?? '';
  let n = 0;
  const sections = blocks.map((b) => `<section data-yan-group="">
<div class="heads">
${b.ds.map((d) => head(d, ++n, summary(d), text(d), reason(d))).join('\n')}
</div>
${media(b, uatDir)}
</section>`).join('\n');
  const list = abandoned.map((d, i) => `<li class="head" data-yan-d="${esc(d.id)}" data-yan-status="${esc(d.status)}">
<span class="box">${CHECK}</span>
<div class="words">
<span class="item">${number(i + 1)}<span data-yan-edit="text">${esc(text(d))}</span>${idOf(d)}</span>
${why(d, reason(d))}
</div>
</li>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_LINKS}
<title>${esc(content.title)}</title>
<style>${STYLE}</style>
</head>
<body data-yan-report="${esc(ctx.id)}">
<div class="cover"></div>
<main class="page">
<header>
<div class="icon">${ICON}</div>
<h1 data-yan-edit="title">${esc(content.title)}</h1>
${properties(ctx)}
</header>
<h2>PROBLEMS</h2>
<p class="problem" data-yan-edit="problem">${esc(content.problem)}</p>
<p class="problem">解决以下问题，我们采用如下方案：</p>
<ol class="approach">
${content.approach.map((a) => `<li><span data-yan-edit="approach">${esc(a)}</span></li>`).join('\n')}
</ol>
${blocks.length === 0 ? '' : `<div data-yan-group="">\n<h2>DELIVERABLES</h2>\n${sections}\n</div>`}
${abandoned.length === 0 ? '' : `<div data-yan-group="">\n<h2>ABANDONED DELIVERABLES</h2>\n<ol>\n${list}\n</ol>\n</div>`}
</main>
</body>
</html>
`;
}

function main() {
  const { content: contentFile, task } = args();
  let content;
  try {
    content = JSON.parse(readFileSync(contentFile, 'utf8'));
  } catch (e) {
    die(`cannot read ${contentFile}: ${e.message}`);
  }
  if (typeof content.title !== 'string' || content.title.trim() === '') die('content.json needs a title');
  if (typeof content.problem !== 'string' || content.problem.trim() === '') die('content.json needs a problem paragraph');
  if (!Array.isArray(content.approach) || content.approach.length === 0 || content.approach.some((a) => typeof a !== 'string' || a.trim() === '')) {
    die('content.json needs an approach: a list of the points the problem was solved by');
  }

  const ctx = context(task);
  const artifacts = join(dirname(ctx.problem.file), 'artifacts');
  const uatDir = join(artifacts, 'uat');
  const shown = blocksOf(ctx, uatDir).blocks.flatMap((b) => b.ds.map((d) => d.id));
  const missing = shown.filter((id) => typeof content.summaries?.[id] !== 'string' || content.summaries[id].trim() === '');
  if (missing.length > 0) die(`content.json has no summary for ${missing.join(', ')}: every deliverable not given up has one, as its heading`);

  writeFileSync(join(artifacts, 'report.html'), page(ctx, content, uatDir));
  const files = Object.fromEntries(ctx.uat.files
    .filter((f) => existsSync(join(uatDir, f.path)))
    .map((f) => [f.path, { sha256: sha256(join(uatDir, f.path)), for: f.for }]));
  writeFileSync(join(artifacts, 'report.json'), `${JSON.stringify({
    version: 1,
    task: ctx.id,
    generatedAt: new Date().toISOString(),
    deliverables: ctx.deliverables.map((d) => ({ id: d.id, status: d.status, text: d.text })),
    files,
  }, null, 2)}\n`);

  const bare = ctx.deliverables.filter((d) => d.status !== 'abandoned' && !(d.id in ctx.uat.notes) && !ctx.uat.files.some((f) => f.for.includes(d.id)));
  process.stdout.write(`wrote ${join(artifacts, 'report.html')}\n`);
  if (bare.length > 0) process.stdout.write(`nothing to check these by: ${bare.map((d) => d.id).join(', ')}\n`);
}

main();
