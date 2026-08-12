import { describe, expect, it } from 'vitest';
import { isInside, normalizePath, samePath } from '../../src/util/paths.js';

/**
 * plan/conventions.md §3: any comparison between a path we built and a path an
 * external tool printed must normalise first, and a single `normalizePath()`
 * owns it. This is the reduced survivor of mvp conventions §2.4.
 */

const windows = process.platform === 'win32';

describe('normalizePath', () => {
  it('turns backslashes into forward slashes', () => {
    expect(normalizePath('C:\\workspace\\project\\Yan')).toBe('C:/workspace/project/Yan');
  });

  it('upper-cases the drive letter', () => {
    expect(normalizePath('c:/workspace')).toBe('C:/workspace');
  });

  it('drops a trailing slash but keeps a root', () => {
    expect(normalizePath('C:/workspace/')).toBe('C:/workspace');
    expect(normalizePath('C:/')).toBe('C:/');
    expect(normalizePath('/')).toBe('/');
  });

  it('collapses duplicate separators', () => {
    expect(normalizePath('C:/a//b///c')).toBe('C:/a/b/c');
  });

  it('translates a Cygwin drive path on any platform', () => {
    expect(normalizePath('/cygdrive/c/workspace')).toBe('C:/workspace');
  });

  it.runIf(windows)('translates an MSYS drive path on Windows', () => {
    expect(normalizePath('/c/workspace/project/Yan')).toBe('C:/workspace/project/Yan');
  });

  it.skipIf(windows)('leaves /c/... alone on Linux, where it is a real directory', () => {
    expect(normalizePath('/c/workspace')).toBe('/c/workspace');
  });

  it('leaves an ordinary POSIX path alone', () => {
    expect(normalizePath('/home/user/project')).toBe('/home/user/project');
  });
});

describe('samePath', () => {
  it('sees through the spellings git and herdr print', () => {
    expect(samePath('C:\\workspace\\Yan', 'C:/workspace/Yan')).toBe(true);
    expect(samePath('C:/workspace/Yan/', 'C:/workspace/Yan')).toBe(true);
    expect(samePath('C:/workspace/Yan', 'C:/workspace/Other')).toBe(false);
  });

  it.runIf(windows)('is case-insensitive on Windows only', () => {
    expect(samePath('C:/Workspace/Yan', 'C:/workspace/yan')).toBe(true);
  });
});

describe('isInside', () => {
  it('is true for the directory itself and for children', () => {
    expect(isInside('C:/a/b', 'C:/a/b')).toBe(true);
    expect(isInside('C:/a/b', 'C:/a/b/c/d')).toBe(true);
  });

  it('is not fooled by a shared prefix that is not a path boundary', () => {
    expect(isInside('C:/a/b', 'C:/a/bc')).toBe(false);
  });
});
