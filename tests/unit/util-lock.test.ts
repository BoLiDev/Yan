import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isHeld, isStale, withLock } from '../../src/util/lock.js';
import { LockError } from '../../src/util/lock.js';
import { cleanupTempDirs, mkTempDir } from '../helpers/fixtures.js';

/**
 * The port of `tests/unit/lib-lock.test.sh`.
 *
 * The primitive is `fs.open(path, 'wx')`, not a
 * mkdir scheme and not a second invention. Two callers, and they are named in
 * `src/util/lock.ts`.
 */

afterAll(cleanupTempDirs);

function lockPath(): string {
  return join(mkTempDir(), 'lock');
}

describe('holding a lock', () => {
  it('creates it, stamps the owner, and releases it afterwards', () => {
    const file = lockPath();
    const seen = withLock(file, 5, () => {
      expect(existsSync(file)).toBe(true);
      const record = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; host: string };
      expect(record.pid).toBe(process.pid);
      expect(record.host).toBe(hostname());
      expect(isHeld(file)).toBe(true);
      return 'body ran';
    });
    expect(seen).toBe('body ran');
    expect(existsSync(file)).toBe(false);
  });

  it('releases it when the body throws', () => {
    const file = lockPath();
    expect(() =>
      withLock(file, 5, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(file)).toBe(false);
  });

  it('refuses to take a lock somebody live already holds', () => {
    const file = lockPath();
    withLock(file, 5, () => {
      let thrown: unknown;
      try {
        // A zero timeout so the test does not sit here for a minute.
        withLock(file, 0, () => undefined);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(LockError);
      expect((thrown as LockError).code).toBe('lock_timeout');
      expect((thrown as LockError).message).toContain(`pid ${process.pid}`);
    });
  });
});

describe('stale locks', () => {
  it('a lock whose owner is gone is reclaimable', () => {
    const file = lockPath();
    // pid 2^22 is above Linux's default pid_max and is not a live process here.
    writeFileSync(file, `${JSON.stringify({ pid: 4194304, host: hostname(), at: 1 })}\n`);
    expect(isStale(file)).toBe(true);
    expect(isHeld(file)).toBe(false);

    let ran = false;
    withLock(file, 5, () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('a lock taken on another machine is never stolen', () => {
    const file = lockPath();
    writeFileSync(file, `${JSON.stringify({ pid: 4194304, host: 'some-other-host', at: 1 })}\n`);
    expect(isStale(file)).toBe(false);
    expect(isHeld(file)).toBe(true);
    expect(() => withLock(file, 0, () => undefined)).toThrow(LockError);
  });

  it('a lock with no stamp yet is left alone while it could still be a competitor', () => {
    const file = lockPath();
    writeFileSync(file, '');
    // Just created, so not yet reclaimable.
    expect(isStale(file)).toBe(false);
  });
});
