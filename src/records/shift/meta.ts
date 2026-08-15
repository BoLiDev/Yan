import { join } from 'node:path';
import { readJsonIfPresent } from '../../util/json.js';
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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const meta = raw as Record<string, unknown>;

  const first = (...keys: readonly string[]): string | undefined => {
    for (const k of keys) {
      const v = meta[k];
      if (typeof v === 'string' && v !== '') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
    return undefined;
  };

  // A field is taken from the first spelling present, in the order listed.
  return strip({
    unit: first('unit'),
    branch: first('branch'),
    tree: first('tree'),
    agent: first('agent'),
    agentId: first('pane', 'pane_id', 'window', 'window_id', 'agent_id', 'term_id'),
    mr: first('mr', 'mr_url'),
    agentSession: first('agent_session', 'session_id'),
    clone: first('clone'),
    leaseId: first('lease_id', 'leaseId'),
    holder: first('holder'),
    container: first('container'),
  });
}

/** Drop undefined values, so an absent field has no key at all. */
function strip(meta: Record<string, string | undefined>): ShiftMeta {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) out[k] = v;
  return out as ShiftMeta;
}
