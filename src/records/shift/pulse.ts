import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `run/pulse` — whether a shift's terminal is moving.
 *
 * A shift can be alive and stuck, and those look identical from outside: the
 * agent is running, the merge request does not exist yet, and nothing has been
 * reported. `yan state` can say `running` about a shift that has been parked on
 * the same screen for twenty minutes. This is the missing signal, and it is the
 * only one yan has for the long silences — an `npm install`, a large refactor,
 * a model thinking.
 *
 * A hash, never the text. The whole value of a shift is that its
 * implementation stays out of the main agent's context; a command that answered
 * this by printing the transcript would hand back exactly what was being kept
 * away. What crosses the boundary is a digest and two timestamps.
 *
 *   <changed> <seen> <hash>
 *
 * `changed` is when the digest last differed, `seen` is when it was last taken.
 * Two numbers rather than one because they answer different questions: how long
 * the terminal has been still, and whether anybody is currently looking. A
 * pulse whose `seen` is minutes old says nothing about the shift — it says no
 * watcher is running — and reading the first number without the second is how
 * "nobody sampled it" becomes "it has been still for an hour".
 *
 * Sampling belongs to `yan wait`, which already wakes on a timer, and never to
 * `yan state`. If `state` hashed the pane itself the answer would be "nothing
 * changed between your two calls", so the reading would depend on how often it
 * was asked — the more anxious the caller, the more stuck the shift would look.
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
 * Record a sample, and return what the file now says.
 *
 * `changed` only moves when the digest does, so a terminal painting the same
 * spinner frame for ten minutes reads as still — which is the honest answer,
 * and the reason this is a digest of the text rather than a byte count.
 *
 * A write that fails costs one sample. This is a signal, not a record: losing
 * it means the next reader sees an older `seen`, which is a thing they can
 * already handle.
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
    // Nothing to do about it, and nothing depends on it having worked.
  }
  return pulse;
}
