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
import { YanError, type YanErrorOptions } from './error.js';

/**
 * Read and write JSON. Every write lands through a temporary file in the
 * target's own directory and a rename, so a reader never sees a half-written
 * file and a failed write leaves the previous content intact. Objects written
 * carry a `version` field, and output is two-space indented, LF, with a
 * trailing newline on both platforms.
 */

const CODES = {
  missing: 'json_missing',
  invalid: 'json_invalid',
  writeFailed: 'json_write_failed',
} as const;

export type JsonErrorKind = keyof typeof CODES;

/** What reading or writing one of yan's JSON files can fail with. */
export class JsonError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: JsonErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(kind: JsonErrorKind, message: string): JsonError {
    return new JsonError(kind, message, { exitCode: 2 });
  }
}

let tmpCounter = 0;

function serialize(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (cause) {
    throw new JsonError('invalid', 'refusing to write a value that is not JSON', { cause });
  }
  if (text === undefined) {
    throw new JsonError('invalid', 'refusing to write a value that is not JSON');
  }
  return `${text}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Add `version` when the top level is an object and does not already have one. */
function withVersion(value: unknown, fallback = 1): unknown {
  if (isPlainObject(value) && !Object.hasOwn(value, 'version')) {
    return { ...value, version: fallback };
  }
  return value;
}

function atomicWrite(file: string, value: unknown, versionFallback = 1): void {
  if (!file) throw JsonError.usage('writeFailed', 'a target file is required');

  const text = serialize(withVersion(value, versionFallback));

  const dir = dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw new JsonError('writeFailed', `cannot create directory: ${dir}`, { cause });
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
    throw new JsonError('writeFailed', `cannot replace ${file}`, { cause });
  }
}

/**
 * Parse text.
 *
 * @throws JsonError `invalid` when it is not JSON.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new JsonError('invalid', 'not valid JSON', { cause });
  }
}

/**
 * The whole file, parsed.
 *
 * @throws JsonError `missing` when it cannot be read, `invalid` when it does
 *   not parse.
 */
export function readJson(file: string): unknown {
  if (!file) throw JsonError.usage('missing', 'a file is required');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new JsonError('missing', `no such file: ${file}`, { cause });
  }
  try {
    return parseJson(text);
  } catch (cause) {
    throw new JsonError('invalid', `not valid JSON: ${file}`, { cause });
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
 * Replace a file's contents from raw text, which is parsed first.
 *
 * @throws JsonError `invalid` when the text is empty or not JSON; the target
 *   is untouched in that case.
 */
export function writeJsonText(file: string, text: string): void {
  if (text === '') {
    throw new JsonError('invalid', `refusing to write empty content to ${file}`);
  }
  atomicWrite(file, parseJson(text));
}

/**
 * Read-modify-write, atomically. The file's existing `version` is carried over
 * unless `edit` set one itself, and a throwing `edit` leaves the file
 * untouched.
 */
export function editJson(file: string, edit: (current: unknown) => unknown): void {
  const current = readJson(file);
  const existingVersion =
    isPlainObject(current) && typeof current.version === 'number' ? current.version : 1;
  atomicWrite(file, edit(current), existingVersion);
}

/** Create the file only when it is absent, and say whether it was written. */
export function initJson(file: string, value: unknown): boolean {
  if (existsSync(file)) return false;
  atomicWrite(file, value);
  return true;
}
