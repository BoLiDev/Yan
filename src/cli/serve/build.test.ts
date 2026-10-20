import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrint } from './build.js';

const home = mkdtempSync(join(tmpdir(), 'yan-build-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('buildPrint', () => {
  it('is empty with nothing built, and moves when a file in dist/ or the page does', () => {
    expect(buildPrint(home)).toBe('');
    mkdirSync(join(home, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(home, 'templates', 'serve'), { recursive: true });
    writeFileSync(join(home, 'dist', 'cli', 'yan.js'), 'one');
    writeFileSync(join(home, 'templates', 'serve', 'app.js'), 'page');
    const first = buildPrint(home);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(buildPrint(home)).toBe(first);

    utimesSync(join(home, 'templates', 'serve', 'app.js'), new Date(1), new Date(1));
    const second = buildPrint(home);
    expect(second).not.toBe(first);
    writeFileSync(join(home, 'dist', 'cli', 'other.js'), 'two');
    expect(buildPrint(home)).not.toBe(second);
  });

  it('leaves out what is not dist/ or the page', () => {
    const before = buildPrint(home);
    mkdirSync(join(home, 'tasks'), { recursive: true });
    writeFileSync(join(home, 'tasks', 'x'), 'x');
    expect(buildPrint(home)).toBe(before);
  });
});
