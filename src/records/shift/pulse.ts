import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `run/pulse` holds one line, `<changed> <seen> <hash>`, digesting a shift's
 * terminal. A reader that uses `changed` without `seen` cannot tell a still
 * terminal from an unsampled one.
 */

export interface Pulse {
  /** Epoch seconds when the digest last differed. */
  readonly changed: number;
  /** Epoch seconds of the most recent sample. */
  readonly seen: number;
  readonly hash: string;
}

export function pulseFile(run: string): string {
  return join(run, 'pulse');
}

export function digestOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function readPulse(run: string): Pulse | undefined {
  const file = pulseFile(run);
  if (!existsSync(file)) return undefined;
  let line: string;
  try {
    line = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')[0] ?? '';
  } catch {
    return undefined;
  }
  const [changed, seen, hash] = line.split(' ');
  if (changed === undefined || !/^\d+$/.test(changed)) return undefined;
  if (seen === undefined || !/^\d+$/.test(seen)) return undefined;
  return { changed: Number(changed), seen: Number(seen), hash: hash ?? '' };
}

/**
 * Record a sample and return what the file now says. `changed` carries over
 * from the previous sample whenever the digest is unchanged. A write that
 * fails is swallowed, so the returned pulse can be newer than the file.
 */
export function writePulse(run: string, text: string, now: number): Pulse {
  const hash = digestOf(text);
  const at = Math.floor(now / 1000);
  const previous = readPulse(run);
  const pulse: Pulse = {
    changed: previous !== undefined && previous.hash === hash ? previous.changed : at,
    seen: at,
    hash,
  };
  try {
    mkdirSync(run, { recursive: true });
    writeFileSync(pulseFile(run), `${pulse.changed} ${pulse.seen} ${pulse.hash}\n`);
  } catch {
    // Swallowed: see above.
  }
  return pulse;
}
