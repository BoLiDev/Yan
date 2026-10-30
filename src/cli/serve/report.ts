import { createHash } from 'node:crypto';
import type { Deliverable } from './vault-view.js';

/**
 * A task's report, artifacts/report.html, as `yan serve` handles it. The
 * yan:uat skill writes the page and report.json beside it; the page marks
 * what serve may touch with data-yan-* attributes, and nothing else in it is
 * read or changed here.
 *
 * - The copy that is downloaded, `handout`, shows each deliverable as
 *   task.json has it now, not as it was when the page was written, and
 *   leaves the ones given up out.
 * - A text `user` edits on the page replaces that one text in the file, by
 *   its place among the editable ones; the page's markup is never taken from
 *   the browser.
 * - `behind` says what changed since the page was written, from what
 *   report.json recorded: deliverables reworded, added or gone, evidence
 *   recorded, replaced or dropped. A change of state is not among them,
 *   since the page shows it anyway.
 */

const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** An element holding only text: `<span data-yan-edit="summary">…</span>`. */
const EDITABLE = /(<([a-z][a-z0-9]*)\b[^>]*\bdata-yan-edit="[a-z]+"[^>]*>)([^<]*)(<\/\2>)/g;

/**
 * Where the element that `at`, a place inside its opening tag, belongs to
 * starts and ends, by counting the tags of its name that open and close
 * after it.
 */
function elementAround(html: string, at: number): { start: number; end: number } {
  const start = html.lastIndexOf('<', at);
  const name = /^<([a-z][a-z0-9]*)/.exec(html.slice(start))?.[1] ?? '';
  const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return { start, end: m.index + m[0].length };
  }
  return { start, end: html.length };
}

/** The page without that element, nor the line break after it. */
const cut = (html: string, el: { start: number; end: number }): string =>
  html.slice(0, el.start) + html.slice(html[el.end] === '\n' ? el.end + 1 : el.end);

const DELIVERABLE = 'data-yan-d="';
const GROUP = 'data-yan-group=""';

/**
 * A page written while its header listed the sub-tasks run elsewhere,
 * without that row, as one written now has none: shown and downloaded alike.
 */
export function withoutSubtasks(html: string): string {
  return html.replace(/<dt>子任务<\/dt><dd>[\s\S]*?<\/dd>/g, '');
}

/**
 * The copy of the page that is downloaded, which is handed to others as a
 * report of what was delivered: each deliverable in the state it has now,
 * the ones given up left out, and the counts of the rest. A part marked
 * data-yan-group with no deliverable left in it goes too, and a heading's
 * data-yan-alone becomes its text once no deliverable comes before it.
 *
 * The numbers in data-yan-n are counted again from 1 under each heading,
 * so one given up on the page after it was written leaves no gap. A page
 * written before deliverables were numbered by place has none, and keeps
 * its numbers.
 */
export function handout(html: string, deliverables: readonly Deliverable[]): string {
  let out = withoutSubtasks(html);
  for (const d of deliverables) {
    const id = d.id.replace(/[^\w-]/g, '');
    if (d.status === 'abandoned') {
      const at = out.indexOf(`${DELIVERABLE}${id}"`);
      if (at !== -1) out = cut(out, elementAround(out, at));
      continue;
    }
    out = out.replace(new RegExp(`(data-yan-d="${id}" data-yan-status=")[a-z]*(")`, 'g'), `$1${d.status}$2`);
    out = out.replace(new RegExp(`(data-yan-d="${id}"[\\s\\S]*?<span data-yan-reason="">)[^<]*(</span>)`), '$1$2');
  }
  // From the top again after every cut: a block gone can leave the part holding it empty.
  for (let at = out.indexOf(GROUP); at !== -1; ) {
    const el = elementAround(out, at);
    if (out.slice(el.start, el.end).includes(DELIVERABLE)) at = out.indexOf(GROUP, at + 1);
    else {
      out = cut(out, el);
      at = out.indexOf(GROUP);
    }
  }
  out = out.replace(/(<h2 data-yan-alone="([^"]*)">)[^<]*(<\/h2>)/g, (whole, open: string, alone: string, close: string, at: number) =>
    out.slice(0, at).includes(DELIVERABLE) ? whole : `${open}${alone}${close}`);
  let n = 0;
  out = out.replace(/<h2\b|(<span data-yan-n="">)\d+(\. <\/span>)/g, (whole, open: string | undefined, close: string | undefined) => {
    if (open === undefined) {
      n = 0;
      return whole;
    }
    n += 1;
    return `${open}${n}${close}`;
  });

  // Done out of what is to be delivered; a page rendered before keeps a part of its bar for the given up, emptied.
  const kept = deliverables.filter((d) => d.status !== 'abandoned');
  const done = kept.filter((d) => d.status === 'done').length;
  const pct = (kept.length === 0 ? 0 : (done / kept.length) * 100).toFixed(2);
  out = out.replace(/(<span data-yan-progress="">)[^<]*(<\/span>)/, `$1${done}/${kept.length}$2`);
  out = out.replace(/(data-yan-bar="done" style="width:)[\d.]+(%")/, `$1${pct}$2`);
  return out.replace(/(data-yan-bar="abandoned" style="width:)[\d.]+(%")/, (_, a: string, b: string) => `${a}0.00${b}`);
}

/** How many texts the page lets `user` edit. */
export function editableCount(html: string): number {
  return [...html.matchAll(EDITABLE)].length;
}

/**
 * The page with its `index`th editable text, in page order, replaced by
 * `text`, which goes in as text.
 *
 * @throws RangeError when the page has no such text.
 */
export function editText(html: string, index: number, text: string): string {
  let at = -1;
  let found = false;
  const out = html.replace(EDITABLE, (whole, open: string, _tag: string, _old: string, close: string) => {
    at += 1;
    if (at !== index) return whole;
    found = true;
    return `${open}${esc(text.replace(/[\r\n]+/g, ' ').trim())}${close}`;
  });
  if (!found) throw new RangeError(`the report has no editable text ${index}`);
  return out;
}

const INLINE_IMAGE = /<img\b([^>]*?)\ssrc="data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]*)"/g;

/**
 * The page with each picture inside it taken out and pointed at `url(n)`,
 * the nth, loaded only as it comes near. The report skill puts its pictures
 * in the page as base64 so the file can be dragged into a document whole;
 * shown on yan serve that is megabytes for the page to take in at each
 * opening before it draws a line, so serve hands the page out light and
 * the pictures beside it.
 */
export function imagesOut(html: string, url: (n: number) => string): { html: string; images: { type: string; bytes: Buffer }[] } {
  const images: { type: string; bytes: Buffer }[] = [];
  const out = html.replace(INLINE_IMAGE, (_, attrs: string, type: string, data: string) => {
    images.push({ type, bytes: Buffer.from(data, 'base64') });
    return `<img${attrs} loading="lazy" decoding="async" src="${url(images.length - 1)}"`;
  });
  return { html: out, images };
}

/** What report.json says the page was written from; fields it cannot read are left empty. */
export interface ReportRecord {
  readonly generatedAt: string | null;
  readonly deliverables: readonly { readonly id: string; readonly text: string }[];
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly for: readonly string[] }>>;
}

export function readRecord(raw: unknown): ReportRecord {
  const doc = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const deliverables = Array.isArray(doc.deliverables)
    ? doc.deliverables.flatMap((d) => (typeof d?.id === 'string' && typeof d?.text === 'string' ? [{ id: d.id as string, text: d.text as string }] : []))
    : [];
  const files: Record<string, { sha256: string; for: string[] }> = {};
  for (const [path, v] of Object.entries(typeof doc.files === 'object' && doc.files !== null ? doc.files : {})) {
    const e = v as Record<string, unknown>;
    if (typeof e?.sha256 === 'string') files[path] = { sha256: e.sha256, for: Array.isArray(e.for) ? e.for.filter((x): x is string => typeof x === 'string') : [] };
  }
  return { generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : null, deliverables, files };
}

/**
 * The evidence as uat.json has it now, each file with the sha-256 of what is
 * in it. Its notes are not among it: the page shows only the files, so a note
 * changed leaves it as true as it was.
 */
export interface Evidence {
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly for: readonly string[] }[];
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** What changed since the page was written, a line each; [] when nothing did. */
export function behind(record: ReportRecord, deliverables: readonly Deliverable[], evidence: Evidence): string[] {
  const said: string[] = [];
  const then = new Map(record.deliverables.map((d) => [d.id, d.text]));
  for (const d of deliverables) {
    const was = then.get(d.id);
    if (was === undefined) said.push(`新加了 ${d.id}`);
    else if (was !== d.text) said.push(`${d.id} 的描述改了`);
  }
  for (const id of then.keys()) if (!deliverables.some((d) => d.id === id)) said.push(`${id} 不在了`);

  for (const f of evidence.files) {
    const was = record.files[f.path];
    if (was === undefined) said.push(`新登记了 uat/${f.path}`);
    else if (was.sha256 !== f.sha256) said.push(`uat/${f.path} 换了新的`);
    else if (!sameList(was.for, f.for)) said.push(`uat/${f.path} 改成了证明 ${f.for.join('、')}`);
  }
  for (const path of Object.keys(record.files)) if (!evidence.files.some((f) => f.path === path)) said.push(`uat/${path} 不再登记`);
  return said;
}
