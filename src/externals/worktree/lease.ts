import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '../../util/json.js';
import { leaseFile, leasesDir, pathKey, absolute } from './layout.js';
import type { Lease } from './types.js';

/**
 * Reading and writing the lease records. Every write goes through
 * `util/json.ts`'s tmp → rename, so a reader never sees a half-written record.
 */

export function readLease(file: string): Lease | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as Lease;
  } catch {
    return undefined;
  }
}

export function allLeases(dir: string): Lease[] {
  let names: string[];
  try {
    names = readdirSync(leasesDir(dir));
  } catch {
    return [];
  }
  const leases: Lease[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const lease = readLease(join(leasesDir(dir), name));
    if (lease !== undefined) leases.push(lease);
  }
  return leases.sort((a, b) => a.slot - b.slot);
}

/**
 * Drop leases whose tree is gone, and only those — a lease whose owning
 * process died keeps its tree, which may still hold work.
 */
export function reclaim(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(leasesDir(dir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(leasesDir(dir), name);
    const path = readLease(file)?.path ?? '';
    if (path === '' || !existsSync(path)) rmSync(file, { force: true });
  }
}

export function newLeaseId(): string {
  return randomBytes(8).toString('hex');
}

/** Write the record for a freshly leased slot. */
export function writeLease(
  dir: string,
  slot: number,
  fields: { path: string; branch: string; base: string; holder: string; leaseId: string },
): void {
  writeJson(leaseFile(dir, slot), {
    version: 1,
    slot,
    path: fields.path,
    branch: fields.branch,
    base: fields.base,
    holder: fields.holder,
    lease_id: fields.leaseId,
    at: Math.floor(Date.now() / 1000),
    pid: process.pid,
  });
}

export function releaseLease(dir: string, slot: number): void {
  rmSync(leaseFile(dir, slot), { force: true });
}

/** Which slot a path or a slot number names, or undefined when nothing matches. */
export function slotOf(dir: string, target: string): number | undefined {
  if (target === '') return undefined;
  if (/^[0-9]+$/.test(target)) {
    const slot = Number(target);
    return existsSync(leaseFile(dir, slot)) ? slot : undefined;
  }
  const want = pathKey(target);
  const wantAbs = pathKey(absolute(target));
  for (const lease of allLeases(dir)) {
    if (lease.path === undefined) continue;
    if (pathKey(lease.path) === want || pathKey(absolute(lease.path)) === wantAbs) return lease.slot;
  }
  return undefined;
}
