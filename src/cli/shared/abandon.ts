import { rmSync } from 'node:fs';
import { readNote } from './note.js';
import { cloneOf, closePane, returnLease, type Closer, type PoolFor } from './teardown.js';
import { mrStateOrUnknown, type MrStateReader } from './mr-state.js';
import { RemoteGit } from '../../externals/remote-git/index.js';
import type { Shift } from '../../records/shift/index.js';
import { YanError } from '../../util/error.js';

/**
 * Giving a shift up without accepting its work, as `yan shift abandon` does
 * for one and `yan abandon` for every one a task has live: the consent both
 * need, the teardown, and how the result reads.
 */

/** What abandoning needs from the outside. Each defaults to the real one. */
export interface AbandonDeps {
  readonly terminal?: Closer;
  readonly pool?: PoolFor;
  readonly mrStateOf?: MrStateReader;
  readonly closeMr?: (mr: string, dir: string | undefined) => void;
}

/** What became of a merge request that was asked to close. */
export type MrClosing = 'closed' | 'already-closed' | 'merged' | 'unknown' | 'failed' | 'none';

export interface AbandonedShift {
  readonly sid: string;
  readonly unit: string;
  readonly mr: string;
  readonly mr_closing: MrClosing;
  readonly tree_returned: boolean;
  readonly pane_closed: boolean;
  readonly pane: string;
}

export function requireConsent(command: string, userAsked: boolean | undefined, reason: string | undefined): string {
  if (userAsked !== true) {
    throw YanError.usage(`${command}_usage`, "abandoning destroys work that exists nowhere else and closes merge requests colleagues can see, so only user asks for it. Nothing was touched. When they have, re-run with --user-asked");
  }
  const text = readNote(command, reason);
  if (text === '') {
    throw YanError.usage(`${command}_usage`, '--reason is required - one line saying why this is being given up, which is what the log keeps');
  }
  return text;
}

/**
 * Close a merge request that is still open, and answer what became of it.
 * Never throws: a forge that cannot be reached must not keep the local work
 * alive, so the failure is reported instead.
 */
export function closeIfOpen(mr: string, dir: string | undefined, deps: AbandonDeps): MrClosing {
  if (mr === '') return 'none';
  const state = mrStateOrUnknown({ mr, dir }, deps.mrStateOf);
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'already-closed';
  if (state === 'unknown') return 'unknown';
  try {
    (deps.closeMr ?? ((url: string, d: string | undefined) => new RemoteGit().closeMr({ mr: url, dir: d })))(mr, dir);
    return 'closed';
  } catch {
    return 'failed';
  }
}

/**
 * Tear one live shift down without accepting its work. The caller has the
 * consent and the reason; this does the work and never throws for the forge,
 * the terminal or the pool, reporting each instead.
 */
export function tearDown(shift: Shift, deps: AbandonDeps): AbandonedShift {
  const meta = shift.meta();
  const unit = meta.unit ?? '';
  const tree = meta.tree ?? '';
  const pane = meta.pane ?? '';
  const clone = meta.clone ?? cloneOf(shift.task, unit);

  const mr = shift.openedMr(meta);
  const mrClosing = closeIfOpen(mr, clone === '' ? undefined : clone, deps);

  // The agent first, so nothing is still writing into the tree being wiped.
  const paneClosed = closePane(pane, deps.terminal);
  rmSync(shift.run, { recursive: true, force: true });

  let returned = false;
  if (tree !== '' && clone !== '') {
    const back = returnLease(
      clone,
      tree,
      { leaseId: meta.lease_id, holder: meta.holder, force: true },
      deps.pool,
    );
    returned = back.returned;
    if (!back.returned) {
      process.stderr.write(`yan abandon: the tree at ${tree} could not be returned - 'yan tree status' shows the lease (${back.reason ?? ''})\n`);
    }
  }

  return { sid: shift.sid, unit, mr, mr_closing: mrClosing, tree_returned: returned, pane_closed: paneClosed, pane };
}

export function mrPhrase(r: { mr: string; mr_closing: MrClosing }): string {
  switch (r.mr_closing) {
    case 'closed':
      return `; ${r.mr} closed`;
    case 'failed':
      return `; ${r.mr} could NOT be closed`;
    case 'unknown':
      return `; the host could not say what became of ${r.mr}, so it was left`;
    case 'merged':
      return `; ${r.mr} had already merged`;
    default:
      return '';
  }
}

/** Lines a person reads about a torn-down shift, and whether anything is left to do by hand. */
export function describeShift(r: AbandonedShift): { lines: string[]; leftover: boolean } {
  const lines = [`${r.sid} abandoned`];
  if (r.mr !== '') lines.push(`  mr     ${r.mr} (${r.mr_closing})`);
  lines.push(`  tree   ${r.tree_returned ? 'returned' : 'NOT returned'}`);
  let leftover = !r.tree_returned || r.mr_closing === 'failed';
  if (!r.pane_closed) {
    lines.push(`  pane   ${r.pane} is still running an agent - close it by hand`);
    leftover = true;
  }
  return { lines, leftover };
}
