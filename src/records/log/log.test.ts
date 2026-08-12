import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LogError } from './errors.js';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Log } from './index.js';

/**
 * The claim under test: the log cannot rewrite an existing line through its
 * API. That is a claim about the surface, so it is asserted about the surface as
 * well as about the behaviour — a behavioural test can only cover the calls
 * someone thought to make.
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
    // If any of these ever appears, the one invariant this class exists to hold
    // has been lost, and this is the alarm. The surface is now the class, which
    // is a smaller thing to keep watch over than a module's exports.
    const surface = Object.getOwnPropertyNames(Log.prototype);
    for (const forbidden of ['set', 'replace', 'delete', 'edit', 'truncate', 'rewrite']) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface.filter((m) => m !== 'constructor').sort()).toEqual(['append', 'init']);
  });
});

describe('init', () => {
  it('writes the heading once and never touches an existing file', () => {
    const log = new Log('t042');
    log.init('unify the auth header');
    expect(readFileSync(log.file, 'utf8')).toBe('# t042 unify the auth header\n\n');

    log.append('first event', '08-04');
    log.init('a completely different title');
    expect(readFileSync(log.file, 'utf8')).toBe(
      '# t042 unify the auth header\n\n- 08-04  first event\n',
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
    log.append('s1 auth  parse the header', '08-04');
    log.append('s2 auth  → !31 merged', '08-05');

    expect(readFileSync(log.file, 'utf8')).toBe(
      '# t042 x\n\n- 08-04  s1 auth  parse the header\n- 08-05  s2 auth  → !31 merged\n',
    );
  });

  it('creates the log when it is missing, so a caller cannot forget to', () => {
    const log = new Log('t077');
    log.append('straight to the log', '08-04');
    expect(readFileSync(log.file, 'utf8')).toBe('# t077\n\n- 08-04  straight to the log\n');
  });

  it('refuses a multi-line entry, which would forge a second event', () => {
    expect(() => new Log('t042').append('one\ntwo')).toThrow(LogError);
  });

  it('refuses empty arguments', () => {
    expect(() => new Log('')).toThrow(LogError);
    expect(() => new Log('t042').append('')).toThrow(LogError);
  });

  it('defaults the date to today as MM-DD', () => {
    const log = new Log('t042');
    log.append('dated by default');
    const line = readFileSync(log.file, 'utf8').trim().split('\n').pop() ?? '';
    expect(line).toMatch(/^- \d{2}-\d{2} {2}dated by default$/);
  });
});
