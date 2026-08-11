import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  editJson,
  initJson,
  parseJson,
  readJson,
  readJsonIfPresent,
  writeJson,
  writeJsonText,
} from '../../src/util/json.js';
import { JsonError } from '../../src/util/json.js';
import { cleanupTempDirs, mkTempDir } from '../helpers/fixtures.js';

/**
 * The port of `tests/unit/lib-json.test.sh`.
 *
 * Phase 0 Trace: "JSON writes still go tmp → mv and every file still carries
 * `version`; lib-json's tests pass against util/json.ts."
 *
 * Every assertion below has a counterpart in the bash file, except the two
 * marked NEW, which cover the one thing the shell could not express: a value
 * that is not serialisable at all.
 */

afterAll(cleanupTempDirs);

function countTemps(dir: string): number {
  return readdirSync(dir).filter((f) => f.startsWith('.yan-json.')).length;
}

describe('writeJson', () => {
  it('injects version, leaves no temp file, and round-trips', () => {
    const tmp = mkTempDir();
    const f = join(tmp, 'a.json');
    writeJson(f, { a: 1 });

    expect(readJson(f)).toEqual({ a: 1, version: 1 });
    expect(countTemps(tmp)).toBe(0);
  });

  it('respects an explicit version rather than overwriting it', () => {
    const tmp = mkTempDir();
    const g = join(tmp, 'b.json');
    writeJson(g, { version: 7, b: 2 });
    expect((readJson(g) as { version: number }).version).toBe(7);
  });

  it('creates nested directories', () => {
    const tmp = mkTempDir();
    const deep = join(tmp, 'x', 'y', 'z', 'deep.json');
    writeJson(deep, { d: 1 });
    expect(readJson(deep)).toEqual({ d: 1, version: 1 });
  });

  it('writes the temp file beside the target, not in TMPDIR', () => {
    // If the implementation used os.tmpdir() the rename could cross a
    // filesystem and would no longer be atomic. Pointing TMPDIR at something
    // that does not exist proves the template is anchored to the target's own
    // directory.
    const tmp = mkTempDir();
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(tmp, 'definitely-not-here');
    try {
      writeJson(join(tmp, 'c.json'), { c: 3 });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect((readJson(join(tmp, 'c.json')) as { c: number }).c).toBe(3);
    expect(countTemps(tmp)).toBe(0);
  });

  it('writes LF and a trailing newline on every platform', () => {
    const tmp = mkTempDir();
    const f = join(tmp, 'lf.json');
    writeJson(f, { a: 1, b: [1, 2] });
    const raw = readFileSync(f, 'utf8');
    expect(raw).not.toContain('\r');
    expect(raw.endsWith('\n')).toBe(true);
    // jq's default pretty printing, so the two halves of the migration write
    // byte-identical files.
    expect(raw).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "version": 1\n}\n');
  });

  it('refuses a value that is not JSON and leaves the target intact (NEW)', () => {
    const tmp = mkTempDir();
    const f = join(tmp, 'a.json');
    writeJson(f, { a: 1 });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeJson(f, circular)).toThrow(JsonError);
    expect(readJson(f)).toEqual({ a: 1, version: 1 });
    expect(countTemps(tmp)).toBe(0);

    expect(() => writeJson(f, undefined)).toThrow(JsonError);
    expect(readJson(f)).toEqual({ a: 1, version: 1 });
  });
});

describe('writeJsonText', () => {
  it('refuses invalid JSON and the old content survives', () => {
    const tmp = mkTempDir();
    const f = join(tmp, 'a.json');
    writeJson(f, { a: 1 });

    for (const bad of ['{"a":', 'not json at all', '']) {
      expect(() => writeJsonText(f, bad)).toThrow(JsonError);
      expect(readJson(f)).toEqual({ a: 1, version: 1 });
    }
    expect(countTemps(tmp)).toBe(0);
  });

  it('accepts valid JSON text', () => {
    const tmp = mkTempDir();
    const f = join(tmp, 'text.json');
    writeJsonText(f, '{"a": 1}');
    expect(readJson(f)).toEqual({ a: 1, version: 1 });
  });
});

describe('editJson', () => {
  it('preserves version and never leaves a temp file', () => {
    const tmp = mkTempDir();
    const g = join(tmp, 'b.json');
    writeJson(g, { version: 7, b: 2 });

    editJson(g, (c) => ({ ...(c as object), b: 99 }));
    expect(readJson(g)).toEqual({ version: 7, b: 99 });

    editJson(g, (c) => ({ ...(c as object), name: 'hello' }));
    expect((readJson(g) as { name: string }).name).toBe('hello');
    expect((readJson(g) as { version: number }).version).toBe(7);
    expect(countTemps(tmp)).toBe(0);
  });

  it('gives version back to a program that deleted it', () => {
    const tmp = mkTempDir();
    const g = join(tmp, 'b.json');
    writeJson(g, { version: 7, b: 2 });
    editJson(g, (c) => {
      const copy = { ...(c as Record<string, unknown>) };
      delete copy.version;
      return copy;
    });
    expect((readJson(g) as { version: number }).version).toBe(7);
  });

  it('leaves the file untouched when the edit throws', () => {
    const tmp = mkTempDir();
    const g = join(tmp, 'b.json');
    writeJson(g, { version: 7, b: 99 });
    expect(() =>
      editJson(g, () => {
        throw new Error('nope');
      }),
    ).toThrow();
    expect((readJson(g) as { b: number }).b).toBe(99);
    expect(countTemps(tmp)).toBe(0);
  });

  it('refuses a missing file', () => {
    const tmp = mkTempDir();
    expect(() => editJson(join(tmp, 'missing.json'), (c) => c)).toThrow(JsonError);
  });
});

describe('initJson', () => {
  it('creates the file once and never overwrites it', () => {
    const tmp = mkTempDir();
    const i = join(tmp, 'init.json');
    expect(initJson(i, { first: true })).toBe(true);
    expect((readJson(i) as { first: boolean }).first).toBe(true);

    expect(initJson(i, { second: true })).toBe(false);
    expect(readJson(i)).toEqual({ first: true, version: 1 });
  });
});

describe('reading', () => {
  it('refuses a missing file, but readJsonIfPresent does not', () => {
    const tmp = mkTempDir();
    expect(() => readJson(join(tmp, 'missing.json'))).toThrow(JsonError);
    expect(readJsonIfPresent(join(tmp, 'missing.json'))).toBeUndefined();
  });

  it('reports a malformed file rather than returning nonsense', () => {
    const tmp = mkTempDir();
    const f = join(tmp, 'broken.json');
    writeFileSync(f, '{oh no');
    expect(() => readJson(f)).toThrow(JsonError);
  });

  it('parseJson refuses invalid text', () => {
    expect(() => parseJson('{')).toThrow(JsonError);
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });
});
