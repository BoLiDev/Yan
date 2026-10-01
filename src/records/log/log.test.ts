import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Log } from './index.js';
import { YanError } from '../../util/error.js';

beforeEach(() => {
  mkYanHome(mkTempDir());
});

afterAll(cleanupTempDirs);

describe('append', () => {
  it('creates the file with no heading and lines the text up', () => {
    const log = new Log('t042');
    log.append('agreed', 'first', '08-04');
    log.append('changed', 'second', '08-05');
    log.append('paused', 'third', '08-06');
    expect(readFileSync(log.file, 'utf8')).toBe(
      '- 08-04  agreed   first\n- 08-05  changed  second\n- 08-06  paused   third\n',
    );
  });

  it('writes only the three types, and one line', () => {
    const log = new Log('t042');
    expect(() => log.append('delivered' as never, 'x')).toThrow(/agreed changed paused/);
    expect(() => log.append('agreed', 'one\ntwo')).toThrow(YanError);
    expect(() => log.append('agreed', '  ')).toThrow(YanError);
  });
});

describe('recall', () => {
  it('keeps every agreed and changed line, and the tail of any type, old types included', () => {
    const log = new Log('t042');
    mkdirSync(dirname(log.file), { recursive: true });
    writeFileSync(log.file, [
      '# t042 an old heading',
      '',
      '- 09-01  started    old work began',
      '- 09-01  agreed     a decision',
      '- 09-02  delivered  old work finished',
      '- 09-02  changed    a correction',
      '- 09-03  incident   something broke',
      '- 09-04  paused     waiting',
      '',
    ].join('\n'));
    const { lines, total } = log.recall(2);
    expect(total).toBe(6);
    expect(lines).toEqual([
      '- 09-01  agreed     a decision',
      '- 09-02  changed    a correction',
      '- 09-03  incident   something broke',
      '- 09-04  paused     waiting',
    ]);
  });

  it('is empty when there is no log', () => {
    expect(new Log('t999').recall(10)).toEqual({ lines: [], total: 0 });
  });
});
