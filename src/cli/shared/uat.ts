import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { cells, padEnd } from './style.js';
import type { Deliverable, UatData } from '../../records/task/index.js';

/**
 * How `yan uat` lists the evidence: deliverable by deliverable, so the one
 * with nothing to check it by stands out, then any file in uat/ that nothing
 * records.
 *
 *   d9   todo
 *        before  d9-before.png  590×332, the left menu taking room
 *        after   d9-after.png   about 1000×565, the right panel folds away
 *   d6   done
 *        note    restored from the backup after stopping the server
 *   d11  todo   nothing to check it by yet
 */

/** Every file under uat/ but uat.json, forward slashes, dotfiles left out. */
export function uatFiles(dir: string): string[] {
  const walk = (at: string): string[] => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => (e.isDirectory() ? walk(join(at, e.name)) : e.isFile() ? [join(at, e.name)] : []));
  };
  return walk(dir).map((f) => relative(dir, f).split(sep).join('/')).filter((p) => p !== 'uat.json');
}

/** The deliverables a check is wanted for: every one not given up. */
function wanted(deliverables: readonly Deliverable[]): Deliverable[] {
  return deliverables.filter((d) => d.status !== 'abandoned');
}

/** How many of them have a file or a note recorded. */
export function coverage(deliverables: readonly Deliverable[], data: UatData): { covered: number; of: number } {
  const open = wanted(deliverables);
  const covered = open.filter((d) => d.id in data.notes || data.files.some((f) => f.for.includes(d.id))).length;
  return { covered, of: open.length };
}

export function uatLines(deliverables: readonly Deliverable[], data: UatData, dir: string): string[] {
  const open = wanted(deliverables);
  const idWidth = Math.max(0, ...open.map((d) => d.id.length));
  const pad = ' '.repeat(idWidth + 4);
  const lines: string[] = [];
  for (const d of open) {
    const files = data.files.filter((f) => f.for.includes(d.id));
    const note = data.notes[d.id];
    const head = `  ${d.id.padEnd(idWidth)}  ${d.status}`;
    if (files.length === 0 && note === undefined) {
      lines.push(`${head}  nothing to check it by yet`);
      continue;
    }
    lines.push(head);
    const pathWidth = Math.max(0, ...files.map((f) => cells(f.path)));
    for (const f of files) {
      const missing = existsSync(join(dir, f.path)) ? '' : '  (the file is gone)';
      lines.push(`${pad}${(f.side ?? 'file').padEnd(6)}  ${padEnd(f.path, pathWidth)}  ${f.shows}${missing}`);
    }
    if (note !== undefined) lines.push(`${pad}${'note'.padEnd(6)}  ${note}`);
  }
  const loose = uatFiles(dir).filter((p) => !data.files.some((f) => f.path === p));
  if (loose.length > 0) lines.push('', `not recorded - 'yan uat add <file> --for <d> "<what it shows>"'`, ...loose.map((p) => `  ${p}`));
  return lines;
}
