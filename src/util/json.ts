import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { YanError } from './error.js';

/**
 * Read and write JSON. Every write lands through a temporary file in the
 * target's own directory and a rename, so a reader never sees a half-written
 * file and a failed write leaves the previous content intact. What a caller
 * hands over is what lands — a `version` field is the writer's to set — and
 * output is two-space indented, LF, with a trailing newline on both
 * platforms.
 */

let tmpCounter = 0;

function serialize(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (cause) {
    throw new YanError('json_invalid', 'refusing to write a value that is not JSON', { cause });
  }
  if (text === undefined) {
    throw new YanError('json_invalid', 'refusing to write a value that is not JSON');
  }
  return `${text}\n`;
}

function atomicWrite(file: string, value: unknown): void {
  if (!file) throw YanError.usage('json_write_failed', 'a target file is required');

  const text = serialize(value);

  const dir = dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw new YanError('json_write_failed', `cannot create directory: ${dir}`, { cause });
  }

  tmpCounter += 1;
  const tmp = join(dir, `.yan-json.${process.pid}.${tmpCounter}.tmp`);

  try {
    const fd = openSync(tmp, 'wx', 0o644);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }

    if (existsSync(file)) {
      chmodSync(tmp, statSync(file).mode & 0o777);
    }
    renameSync(tmp, file);
  } catch (cause) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created.
    }
    throw new YanError('json_write_failed', `cannot replace ${file}`, { cause });
  }
}

/**
 * Parse text.
 *
 * @throws YanError `invalid` when it is not JSON.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new YanError('json_invalid', 'not valid JSON', { cause });
  }
}

/**
 * The whole file, parsed.
 *
 * @throws YanError `missing` when it cannot be read, `invalid` when it does
 *   not parse.
 */
export function readJson(file: string): unknown {
  if (!file) throw YanError.usage('json_missing', 'a file is required');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new YanError('json_missing', `no such file: ${file}`, { cause });
  }
  try {
    return parseJson(text);
  } catch (cause) {
    throw new YanError('json_invalid', `not valid JSON: ${file}`, { cause });
  }
}

/** `readJson`, but a missing file is `undefined` rather than an error. */
export function readJsonIfPresent(file: string): unknown {
  if (!file || !existsSync(file)) return undefined;
  return readJson(file);
}

/** Replace a file's contents. Creates parent directories. */
export function writeJson(file: string, value: unknown): void {
  atomicWrite(file, value);
}

/**
 * Read-modify-write, atomically. `edit` is handed the whole current value and
 * what it returns is the whole new one, so anything it drops is dropped; a
 * throwing `edit` leaves the file untouched.
 */
export function editJson(file: string, edit: (current: unknown) => unknown): void {
  atomicWrite(file, edit(readJson(file)));
}

/** Create the file only when it is absent, and say whether it was written. */
export function initJson(file: string, value: unknown): boolean {
  if (existsSync(file)) return false;
  atomicWrite(file, value);
  return true;
}
