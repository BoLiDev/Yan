import { existsSync } from 'node:fs';
import { editJson, readJson } from '../../util/json.js';
import { asRecord, asString } from '../../util/narrow.js';
import { TaskError } from './errors.js';
import {type TaskData, type UnitData } from './types.js';

/**
 * The JSON layer under task.json. Reads fill in a default for anything the
 * file omits or mistypes, so only a missing file throws; writes go through
 * `util/json.ts`, landing tmp → mv with key order preserved.
 */

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
    abandoned: raw.abandoned === true,
    units: units.map((u): UnitData => {
      const r = asRecord(u);
      return {
        ...r,
        name: asString(r.name),
        repo: asString(r.repo),
        scope: asStringArray(r.scope),
        needs: asStringArray(r.needs),
        branch: asString(r.branch),
        target: asString(r.target),
        mr: typeof r.mr === 'string' && r.mr !== '' ? r.mr : null,
        history: Array.isArray(r.history) ? (r.history as UnitData['history']) : [],
      };
    }),
  };
}

/**
 * Read-modify-write one task.json, atomically, preserving key order. Anything
 * `edit` throws propagates and leaves the file untouched.
 */
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

/**
 * The same, narrowed to one unit.
 *
 * @throws TaskError `missing` when no unit of that name exists; it is never
 *   created.
 */
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
