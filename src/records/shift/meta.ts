import { join } from 'node:path';
import { readJsonIfPresent } from '../../util/json.js';
import { recordOrNone } from '../../util/narrow.js';
import type { ShiftMeta } from './types.js';

/**
 * Read `run/meta.json` in one pass. Never throws: a missing, unreadable or
 * half-written file yields a record with nothing but the `scenario` default,
 * and any field the file does not carry is absent rather than empty.
 */
export function readMeta(run: string): ShiftMeta {
  let raw: unknown;
  try {
    raw = readJsonIfPresent(join(run, 'meta.json'));
  } catch {
    raw = undefined;
  }
  const meta = recordOrNone(raw) ?? {};

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
