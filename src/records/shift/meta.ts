import { join } from 'node:path';
import { readJsonIfPresent } from '../../util/json.js';
import type { ShiftMeta } from './types.js';

/**
 * Reading `run/meta.json`, once, into a typed value.
 *
 * The shape this replaces was six one-line accessors over a shared `get(...keys)`
 * — `unit`, `branch`, `tree`, `agent`, `agentId`, `mr`. That was not only six
 * names for one idea: each of them re-opened and re-parsed the file, so a caller
 * that wanted three fields parsed the same JSON three times.
 *
 * Invariant 3 lives here: a missing file, a missing key, a half-written file or
 * an unrecognised key answers "I do not know" and never throws.
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

  // Several spellings per field because which one is written is the dispatching
  // phase's decision; accepting both costs a loop and cannot be wrong about it.
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

/** Absent means absent: an explicit `undefined` would survive JSON round trips as a key. */
function strip(meta: Record<string, string | undefined>): ShiftMeta {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) out[k] = v;
  return out as ShiftMeta;
}
