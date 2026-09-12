import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Log, LOG_TYPES, type LogType } from './index.js';
import { YanError } from '../../util/error.js';

/**
 * The log cannot rewrite an existing line through its API, which is a claim
 * about the surface and is asserted about the surface as well as the
 * behaviour.
 */

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

afterAll(cleanupTempDirs);

describe('the append-only surface', () => {
  it('offers no writer that can reach an existing line', () => {
    // The absence of these is what makes the log append-only.
    const surface = Object.getOwnPropertyNames(Log.prototype);
    for (const forbidden of ['set', 'replace', 'delete', 'edit', 'truncate', 'rewrite']) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface.filter((m) => m !== 'constructor').sort()).toEqual(['append', 'excerpt', 'init']);
  });
});

describe('init', () => {
  it('writes the heading once and never touches an existing file', () => {
    const log = new Log('t042');
    log.init('unify the auth header');
    expect(readFileSync(log.file, 'utf8')).toBe('# t042 unify the auth header\n\n');

    log.append('agreed', 'first event', '08-04');
    log.init('a completely different title');
    expect(readFileSync(log.file, 'utf8')).toBe(
      '# t042 unify the auth header\n\n- 08-04  agreed     first event\n',
    );
  });

  it('writes a bare heading when there is no title', () => {
    const log = new Log('t043');
    log.init();
    expect(readFileSync(log.file, 'utf8')).toBe('# t043\n\n');
  });
});

describe('append', () => {
  it('adds one line at the end and leaves every earlier line alone', () => {
    const log = new Log('t042');
    log.init('x');
    log.append('started', 's1 auth  parse the header', '08-04');
    log.append('delivered', 's2 auth  → !31 merged', '08-05');

    expect(readFileSync(log.file, 'utf8')).toBe(
      '# t042 x\n\n- 08-04  started    s1 auth  parse the header\n- 08-05  delivered  s2 auth  → !31 merged\n',
    );
  });

  it('lines the text up whatever the type', () => {
    const log = new Log('t042');
    for (const type of LOG_TYPES) log.append(type, 'x', '08-04');
    const columns = readFileSync(log.file, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.lastIndexOf('x'));
    expect(new Set(columns).size).toBe(1);
  });

  it('creates the log when it is missing, so a caller cannot forget to', () => {
    const log = new Log('t077');
    log.append('paused', 'straight to the log', '08-04');
    expect(readFileSync(log.file, 'utf8')).toBe('# t077\n\n- 08-04  paused     straight to the log\n');
  });

  it('refuses a multi-line entry, which would forge a second event', () => {
    expect(() => new Log('t042').append('agreed', 'one\ntwo')).toThrow(YanError);
    expect(() => new Log('t042').append('agreed', 'one\rtwo')).toThrow(YanError);
  });

  it('refuses a type it does not know', () => {
    expect(() => new Log('t042').append('decided' as LogType, 'x')).toThrow(YanError);
  });

  it('refuses empty arguments', () => {
    expect(() => new Log('')).toThrow(YanError);
    expect(() => new Log('t042').append('agreed', '')).toThrow(YanError);
    expect(() => new Log('t042').append('agreed', '   ')).toThrow(YanError);
  });

  it('defaults the date to today as MM-DD', () => {
    const log = new Log('t042');
    log.append('incident', 'dated by default');
    const line = readFileSync(log.file, 'utf8').trim().split('\n').pop() ?? '';
    expect(line).toMatch(/^- \d{2}-\d{2} {2}incident {3}dated by default$/);
  });
});

describe('excerpt', () => {
  it('keeps every line of the kept types, and the tail of everything', () => {
    const log = new Log('t042');
    log.append('agreed', 'a1', '08-01');
    log.append('started', 's1', '08-01');
    log.append('changed', 'c1', '08-02');
    log.append('delivered', 'd1', '08-02');
    log.append('started', 's2', '08-03');
    log.append('delivered', 'd2', '08-03');

    const { lines, total } = log.excerpt(['agreed', 'changed'], 2);
    expect(total).toBe(6);
    expect(lines.map((l) => l.trim().split(/\s+/).pop())).toEqual(['a1', 'c1', 's2', 'd2']);
  });

  it('does not repeat a kept line that is also in the tail', () => {
    const log = new Log('t042');
    log.append('started', 's1', '08-01');
    log.append('agreed', 'a1', '08-01');
    expect(log.excerpt(['agreed'], 5).lines).toHaveLength(2);
  });

  it('reaches an untyped line from before types only through the tail', () => {
    const log = new Log('t042');
    log.init();
    writeFileSync(log.file, '# t042\n\n- 08-01  auth  unit added\n- 08-01  decided: something\n');
    log.append('started', 's1', '08-02');
    log.append('delivered', 'd1', '08-02');

    expect(log.excerpt(['agreed'], 2).lines.join('\n')).not.toContain('decided');
    expect(log.excerpt(['agreed'], 3).lines.join('\n')).toContain('decided');
  });

  it('is empty when there is no log', () => {
    expect(new Log('t099').excerpt(['agreed'], 20)).toEqual({ lines: [], total: 0 });
  });
});
