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
import { YanError, usageError } from './error.js';

/**
 * Read and write JSON. The TypeScript half of `bin/lib-json.sh`.
 *
 * Stateless, and the only place in the code base that replaces a JSON file.
 * The three invariants are the MVP's, unchanged (td INDEX.md §2):
 *
 *   1. every write goes through a temporary file in the SAME directory as the
 *      target and is then renamed into place, so the rename stays inside one
 *      filesystem and a reader never sees a half-written file;
 *   2. every object written carries a `version` field — the one hook left for
 *      a future schema migration;
 *   3. invalid content is refused before the target is touched, so a failed
 *      write always leaves the previous content intact.
 *
 * What is *gone* is `_json_lf`: there is no `jq.exe` emitting CRLF any more, so
 * the 126 strip sites and the explanation they needed both disappear. Output is
 * LF on both platforms because we write it that way, not because we clean up
 * after someone.
 */

export const JSON_INVALID = 'json_invalid';
export const JSON_MISSING = 'json_missing';
export const JSON_WRITE_FAILED = 'json_write_failed';

let tmpCounter = 0;

function serialize(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (cause) {
    throw new YanError(JSON_INVALID, 'refusing to write a value that is not JSON', { cause });
  }
  if (text === undefined) {
    throw new YanError(JSON_INVALID, 'refusing to write a value that is not JSON');
  }
  // Two-space indent and a trailing newline is jq's default pretty printing, so
  // a file written by the TypeScript half is byte-identical to one written by
  // the shell half. That equality is the whole interop story of the migration
  // (plan/INDEX.md §2).
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
  if (!file) throw usageError(JSON_WRITE_FAILED, 'a target file is required');

  const text = serialize(withVersion(value, versionFallback));

  const dir = dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (cause) {
    throw new YanError(JSON_WRITE_FAILED, `cannot create directory: ${dir}`, { cause });
  }

  // The temporary file is anchored to the target's own directory on purpose:
  // os.tmpdir() could be on another filesystem and the rename would then be a
  // copy, which is not atomic.
  tmpCounter += 1;
  const tmp = join(dir, `.yan-json.${process.pid}.${tmpCounter}.tmp`);

  try {
    // 'wx' is an atomic exclusive create — the primitive plan/conventions.md §4
    // says to use instead of porting the MVP's mkdir lock scheme.
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
      // The temp file may never have been created; nothing to clean up.
    }
    throw new YanError(JSON_WRITE_FAILED, `cannot replace ${file}`, { cause });
  }
}

/** Parse text, refusing anything that is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new YanError(JSON_INVALID, 'not valid JSON', { cause });
  }
}

/** The whole file, parsed. Throws when the file is missing or malformed. */
export function readJson(file: string): unknown {
  if (!file) throw usageError(JSON_MISSING, 'a file is required');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new YanError(JSON_MISSING, `no such file: ${file}`, { cause });
  }
  try {
    return parseJson(text);
  } catch (cause) {
    throw new YanError(JSON_INVALID, `not valid JSON: ${file}`, { cause });
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
 * Replace a file's contents from raw text.
 *
 * Kept because it is the only shape in which invalid JSON can reach the writer
 * at all — a caller holding a parsed value cannot express `{"a":` — and
 * invariant 3 is worth a real test.
 */
export function writeJsonText(file: string, text: string): void {
  if (text === '') {
    throw new YanError(JSON_INVALID, `refusing to write empty content to ${file}`);
  }
  atomicWrite(file, parseJson(text));
}

/**
 * Read-modify-write through the same atomic path.
 *
 * The file's existing `version` is carried over unless the edit set one itself.
 * A throwing edit leaves the file untouched.
 */
export function editJson(file: string, edit: (current: unknown) => unknown): void {
  const current = readJson(file);
  const existingVersion =
    isPlainObject(current) && typeof current.version === 'number' ? current.version : 1;
  atomicWrite(file, edit(current), existingVersion);
}

/** Create the file only when it is absent. Existing content is never touched. */
export function initJson(file: string, value: unknown): boolean {
  if (existsSync(file)) return false;
  atomicWrite(file, value);
  return true;
}
