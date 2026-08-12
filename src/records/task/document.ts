import { existsSync } from 'node:fs';
import { editJson, readJson } from '../../util/json.js';
import { TaskError } from './errors.js';
import { MODES, type Mode, type TaskData, type UnitData } from './types.js';

/**
 * Reading and writing the document itself — the part that knows JSON.
 *
 * Two invariants live here and nowhere else:
 *
 *   1. Read leniently. A missing key, an unexpected key or a half-written array
 *      must never crash a reader. task.json outlives the version of yan that
 *      wrote it, and a task nobody can open is a task nobody can finish.
 *
 *   2. Write through `util/json.ts`, so every write lands tmp → mv and carries
 *      a version field. Key order is preserved on edit rather than rebuilt:
 *      task.json is versioned in the vault, and a rebuild would turn every
 *      one-field change into a whole-file diff.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function requireFile(file: string, id: string): string {
  if (!existsSync(file)) {
    throw new TaskError('missing', `no such task: ${id} - expected ${file}`);
  }
  return file;
}

export function readDocument(file: string, id: string): TaskData {
  const raw = asRecord(readJson(requireFile(file, id)));
  const units = Array.isArray(raw.units) ? raw.units : [];
  return {
    ...raw,
    version: typeof raw.version === 'number' ? raw.version : 1,
    id: asString(raw.id, id),
    title: asString(raw.title),
    complete: raw.complete === true,
    units: units.map((u): UnitData => {
      const r = asRecord(u);
      const mode = asString(r.mode, 'mr');
      return {
        ...r,
        name: asString(r.name),
        repo: asString(r.repo),
        scope: asStringArray(r.scope),
        needs: asStringArray(r.needs),
        branch: asString(r.branch),
        target: asString(r.target),
        mode: (MODES as readonly string[]).includes(mode) ? (mode as Mode) : 'mr',
        mr: typeof r.mr === 'string' && r.mr !== '' ? r.mr : null,
        history: Array.isArray(r.history) ? (r.history as UnitData['history']) : [],
      };
    }),
  };
}

/** Read-modify-write one task.json, atomically, preserving key order. */
export function editDocument(
  file: string,
  id: string,
  edit: (task: Record<string, unknown>) => void,
): void {
  editJson(requireFile(file, id), (current) => {
    const task = asRecord(current);
    edit(task);
    return task;
  });
}

/** The same, narrowed to one unit. Refuses rather than creating one. */
export function editUnitIn(
  file: string,
  id: string,
  unitName: string,
  edit: (unit: Record<string, unknown>) => void,
): void {
  editDocument(file, id, (task) => {
    const units = Array.isArray(task.units) ? task.units : [];
    const unit = units.map(asRecord).find((u) => u.name === unitName);
    if (unit === undefined) throw new TaskError('missing', `no such unit: ${unitName}`);
    edit(unit);
  });
}
