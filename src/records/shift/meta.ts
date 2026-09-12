import { join } from 'node:path';
import { readJsonIfPresent } from '../../util/json.js';
import { recordOrNone } from '../../util/narrow.js';
import type { ShiftMeta } from './types.js';

/**
 * Read `run/meta.json` in one pass. Never throws: a missing, unreadable or
 * half-written file yields `{}`, and any field the file does not carry is
 * absent rather than empty.
 */
export function readMeta(run: string): ShiftMeta {
  let raw: unknown;
  try {
    raw = readJsonIfPresent(join(run, 'meta.json'));
  } catch {
    return {};
  }
  const meta = recordOrNone(raw);
  if (meta === undefined) return {};

  // The keys `yan shift new` writes, and nothing else: a second spelling that
  // no writer produces is a reader guessing.
  const field = (key: string): string | undefined => {
    const v = meta[key];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  };

  return strip({
    unit: field('unit'),
    branch: field('branch'),
    tree: field('tree'),
    agent: field('agent'),
    agentId: field('pane'),
    mr: field('mr'),
    agentSession: field('agent_session'),
    clone: field('clone'),
    leaseId: field('lease_id'),
    holder: field('holder'),
    container: field('container'),
  });
}

/** Drop undefined values, so an absent field has no key at all. */
function strip(meta: Record<string, string | undefined>): ShiftMeta {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) out[k] = v;
  return out as ShiftMeta;
}
