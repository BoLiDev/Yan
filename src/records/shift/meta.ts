import { join } from 'node:path';
import { readJsonOrNone, writeJson } from '../../util/json.js';
import type { ShiftMeta, TeardownRecord } from './types.js';

/**
 * Read `run/meta.json` in one pass. Never throws: a missing, unreadable or
 * half-written file yields a record with nothing but the `scenario` default,
 * and any field the file does not carry is absent rather than empty.
 */
export function readMeta(run: string): ShiftMeta {
  const meta = readJsonOrNone(join(run, 'meta.json')) ?? {};

  // The keys `yan shift new` writes, and nothing else: a second spelling that
  // no writer produces is a reader guessing.
  const text = (key: keyof ShiftMeta): string | undefined => {
    const v = meta[key];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  };

  return {
    ...strip({
      task: text('task'),
      sid: text('sid'),
      unit: text('unit'),
      repo: text('repo'),
      branch: text('branch'),
      base: text('base'),
      tree: text('tree'),
      clone: text('clone'),
      workdir: text('workdir'),
      holder: text('holder'),
      lease_id: text('lease_id'),
      agent: text('agent'),
      tier: text('tier'),
      model: text('model'),
      effort: text('effort'),
      container: text('container'),
      pane: text('pane'),
      mr: text('mr'),
      status: text('status'),
      agent_session: text('agent_session'),
      at: text('at'),
    }),
    ...(typeof meta.version === 'number' ? { version: meta.version } : {}),
    ...(Array.isArray(meta.skills)
      ? { skills: meta.skills.filter((s): s is string => typeof s === 'string') }
      : {}),
    // Only coding opens merge requests, and a record from before scenarios
    // existed was a coding shift. Defaulted here so no caller has to.
    scenario: text('scenario') ?? 'coding',
  };
}

/** Drop undefined values, so an absent field has no key at all. */
function strip(meta: Record<string, string | undefined>): Partial<ShiftMeta> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) out[k] = v;
  return out as Partial<ShiftMeta>;
}

/**
 * Read `teardown.json` from a shift directory. `undefined` when there is none —
 * a shift dispatched before the file existed — or when it does not name a
 * scenario, which is the one thing it is kept for.
 */
export function readTeardown(dir: string): TeardownRecord | undefined {
  const raw = readJsonOrNone(join(dir, 'teardown.json'));
  if (raw === undefined) return undefined;
  const text = (key: keyof TeardownRecord): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const scenario = text('scenario');
  if (scenario === '') return undefined;
  const state = text('mr_state');
  return {
    version: 1,
    scenario,
    unit: text('unit'),
    branch: text('branch'),
    clone: text('clone'),
    ...(state === 'merged' || state === 'none' ? { mr: text('mr'), mr_state: state } : {}),
  };
}

export function writeTeardown(dir: string, record: TeardownRecord): void {
  writeJson(join(dir, 'teardown.json'), record);
}
