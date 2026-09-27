import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir } from '../../tests/helpers/fixtures.js';
import { readVaultJson } from './vault.js';

afterAll(cleanupTempDirs);

describe('readVaultJson', () => {
  it('reads the version and the name', () => {
    const dir = mkTempDir();
    writeFileSync(join(dir, 'vault.json'), JSON.stringify({ version: 1, name: 'personal', created: '2026-09-01' }));
    expect(readVaultJson(dir)).toEqual({ version: 1, name: 'personal', created: '2026-09-01' });
  });

  it('reads a missing file as version 1, quietly', () => {
    expect(readVaultJson(mkTempDir())).toEqual({ version: 1, name: '', created: '' });
  });

  it('refuses a file that is there and is not a JSON object, rather than guess version 1', () => {
    const dir = mkTempDir();
    for (const text of ['{ "version": ', '[1]', 'null']) {
      writeFileSync(join(dir, 'vault.json'), text);
      expect(() => readVaultJson(dir), text).toThrow(expect.objectContaining({ code: 'vault_invalid', exitCode: 1 }));
    }
  });
});
