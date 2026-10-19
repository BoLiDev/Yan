import { createHash } from 'node:crypto';
import type { Deliverable } from './vault-view.js';

/**
 * A task's report, artifacts/report.html, as `yan serve` handles it. The
 * report skill writes the page and report.json beside it; the page marks
 * what serve may touch with data-yan-* attributes, and nothing else in it is
 * read or changed here.
 *
 * - The state of each deliverable is shown as task.json has it now, not as
 *   it was when the page was written: `restate` sets it, for the copy that
 *   is downloaded.
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

/** The page with every deliverable in the state it has now, the counts with it. */
export function restate(html: string, deliverables: readonly Deliverable[]): string {
  let out = html;
  for (const d of deliverables) {
    const id = d.id.replace(/[^\w-]/g, '');
    out = out.replace(new RegExp(`(data-yan-d="${id}" data-yan-status=")[a-z]*(")`, 'g'), `$1${d.status}$2`);
    const reason = d.status === 'abandoned' ? d.reason ?? '' : '';
    out = out.replace(new RegExp(`(data-yan-d="${id}"[\\s\\S]*?<span data-yan-reason="">)[^<]*(</span>)`), (_, a: string, b: string) => `${a}${esc(reason)}${b}`);
  }
  const count = (s: string): number => deliverables.filter((d) => d.status === s).length;
  const [done, todo, gone] = [count('done'), count('todo'), count('abandoned')];
  const pct = (n: number): string => (deliverables.length === 0 ? 0 : (n / deliverables.length) * 100).toFixed(2);
  out = out.replace(/(<span data-yan-progress="">)[^<]*(<\/span>)/, `$1${done} 完成 · ${todo} 待确认 · ${gone} 放弃$2`);
  out = out.replace(/(data-yan-bar="done" style="width:)[\d.]+(%")/, `$1${pct(done)}$2`);
  return out.replace(/(data-yan-bar="abandoned" style="width:)[\d.]+(%")/, `$1${pct(gone)}$2`);
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

/** What report.json says the page was written from; fields it cannot read are left empty. */
export interface ReportRecord {
  readonly generatedAt: string | null;
  readonly deliverables: readonly { readonly id: string; readonly text: string }[];
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly for: readonly string[] }>>;
  readonly notes: Readonly<Record<string, string>>;
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
  const notes = Object.fromEntries(Object.entries(typeof doc.notes === 'object' && doc.notes !== null ? doc.notes : {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return { generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : null, deliverables, files, notes };
}

/** The evidence as uat.json has it now, each file with the sha-256 of what is in it. */
export interface Evidence {
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly for: readonly string[] }[];
  readonly notes: Readonly<Record<string, string>>;
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

  for (const id of new Set([...Object.keys(record.notes), ...Object.keys(evidence.notes)])) {
    const [was, now] = [record.notes[id], evidence.notes[id]];
    if (was === now) continue;
    said.push(was === undefined ? `${id} 加了验证说明` : now === undefined ? `${id} 的验证说明删了` : `${id} 的验证说明改了`);
  }
  return said;
}
