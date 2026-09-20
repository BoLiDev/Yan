import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, repoRoot } from '../../../tests/helpers/fixtures.js';
import { copyFonts, fontSourceDir, FONTS_DIR } from './fonts.js';

/**
 * The copy step, against this clone's own `templates/ui/fonts/`. A suite run
 * from inside a yan session inherits a `$YAN_HOME` naming another clone, and
 * `copyFonts` reads its source from there, so the test pins it to this one.
 */

let previousHome: string | undefined;
beforeAll(() => {
  previousHome = process.env.YAN_HOME;
  process.env.YAN_HOME = repoRoot;
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  cleanupTempDirs();
});

const NAMES = ['yan-round-regular.woff2', 'yan-round-bold.woff2', 'OFL.txt'];

describe('the face beside the page', () => {
  it('is in the repository, as two woff2 files and the licence', () => {
    const dir = join(repoRoot, 'templates', 'ui', 'fonts');
    for (const name of NAMES) expect(statSync(join(dir, name)).size).toBeGreaterThan(0);
    // Small enough for git, large enough to be the real subset and not a stub.
    for (const name of NAMES.slice(0, 2)) {
      const size = statSync(join(dir, name)).size;
      expect(size).toBeGreaterThan(500_000);
      expect(size).toBeLessThan(1_000_000);
    }
    expect(readFileSync(join(dir, 'OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('is written when it is missing', () => {
    const dir = mkTempDir();
    expect(copyFonts(dir)).toEqual({
      'yan-round-regular.woff2': 'written',
      'yan-round-bold.woff2': 'written',
      'OFL.txt': 'written',
    });
    for (const name of NAMES) {
      expect(readFileSync(join(dir, FONTS_DIR, name))).toEqual(readFileSync(join(fontSourceDir(), name)));
    }
  });

  it('leaves a file already there alone, down to its mtime', () => {
    const dir = mkTempDir();
    copyFonts(dir);
    const old = new Date('2020-01-01T00:00:00Z');
    for (const name of NAMES) utimesSync(join(dir, FONTS_DIR, name), old, old);

    expect(copyFonts(dir)).toEqual({
      'yan-round-regular.woff2': 'same',
      'yan-round-bold.woff2': 'same',
      'OFL.txt': 'same',
    });
    for (const name of NAMES) {
      expect(statSync(join(dir, FONTS_DIR, name)).mtimeMs).toBe(old.getTime());
    }
  });

  it('rewrites a file whose bytes differ, and only that file', () => {
    const dir = mkTempDir();
    copyFonts(dir);
    const old = new Date('2020-01-01T00:00:00Z');
    for (const name of NAMES) utimesSync(join(dir, FONTS_DIR, name), old, old);
    writeFileSync(join(dir, FONTS_DIR, 'yan-round-bold.woff2'), 'an older subset');

    expect(copyFonts(dir)).toEqual({
      'yan-round-regular.woff2': 'same',
      'yan-round-bold.woff2': 'written',
      'OFL.txt': 'same',
    });
    expect(readFileSync(join(dir, FONTS_DIR, 'yan-round-bold.woff2'))).toEqual(
      readFileSync(join(fontSourceDir(), 'yan-round-bold.woff2')),
    );
    expect(statSync(join(dir, FONTS_DIR, 'OFL.txt')).mtimeMs).toBe(old.getTime());
  });

  it('says which file it could not write, rather than throwing the filesystem raw', () => {
    const dir = mkTempDir();
    // A directory where a file belongs: the same refusal a read-only target
    // gives, on every platform.
    mkdirSync(join(dir, FONTS_DIR, 'OFL.txt'), { recursive: true });
    expect(() => copyFonts(dir)).toThrow(/^cannot write .*OFL\.txt: /);
    try {
      copyFonts(dir);
    } catch (err) {
      expect((err as { code: string }).code).toBe('ui_fonts');
    }
  });

  it.skipIf(process.platform === 'win32')('says so when the destination is read-only', () => {
    const dir = mkTempDir();
    const fonts = join(dir, FONTS_DIR);
    mkdirSync(fonts, { recursive: true });
    chmodSync(fonts, 0o500);
    try {
      expect(() => copyFonts(dir)).toThrow(/^cannot write .*yan-round-regular\.woff2: /);
    } finally {
      chmodSync(fonts, 0o700);
    }
  });
});
