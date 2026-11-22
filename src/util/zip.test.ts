import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeZip } from './zip.js';
import { cleanupTempDirs, mkTempDir } from '../../tests/helpers/fixtures.js';
import { readZip } from '../../tests/helpers/zip.js';

/** The zip `yan pack` hands to another machine: whatever opens one there has to read it. */

afterAll(cleanupTempDirs);

describe('a zip written', () => {
  it('holds every file as it was, from disk or from memory, under the name given, text that packs well and bytes that do not', () => {
    const dir = mkTempDir();
    const prose = 'the same line, over and over\n'.repeat(500);
    const noise = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + (i >> 3) * 104729) % 256));
    writeFileSync(join(dir, 'prose.md'), prose);
    const file = join(dir, 'out.zip');

    const bytes = writeZip(file, [
      { name: 'pack/设计/prose.md', from: join(dir, 'prose.md') },
      { name: 'pack/noise.bin', from: noise },
      { name: 'pack/empty', from: Buffer.alloc(0) },
    ]);

    const read = readZip(file);
    expect([...read.keys()]).toEqual(['pack/设计/prose.md', 'pack/noise.bin', 'pack/empty']);
    expect(read.get('pack/设计/prose.md')?.toString()).toBe(prose);
    expect(read.get('pack/noise.bin')?.equals(noise)).toBe(true);
    expect(read.get('pack/empty')?.length).toBe(0);
    expect(bytes, 'prose is deflated').toBeLessThan(prose.length);
    expect(existsSync(`${file}.part`), 'nothing half written is left beside it').toBe(false);
  });

  it('is one the machine\'s own unzip takes, where there is one', () => {
    const dir = mkTempDir();
    const file = join(dir, 'out.zip');
    writeZip(file, [{ name: 'a/b.txt', from: Buffer.from('hello\n') }]);
    const tested = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    // No unzip here, as on Windows: the read above is what holds it then.
    if (tested.error !== undefined) return;
    expect(tested.status, tested.stdout + tested.stderr).toBe(0);
  });

  it('leaves the zip that was there when one of its files cannot be read', () => {
    const dir = mkTempDir();
    const file = join(dir, 'out.zip');
    writeZip(file, [{ name: 'kept.txt', from: Buffer.from('kept') }]);
    expect(() => writeZip(file, [{ name: 'gone.txt', from: join(dir, 'not-there') }])).toThrow();
    expect([...readZip(file).keys()]).toEqual(['kept.txt']);
    expect(existsSync(`${file}.part`)).toBe(false);
  });
});
