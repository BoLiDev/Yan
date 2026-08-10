import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as log from '../../src/store/log.js';
import { YanError } from '../../src/util/error.js';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../helpers/fixtures.js';

/**
 * The port of `tests/unit/lib-log.test.sh`.
 *
 * Phase 1 Trace: "log.ts cannot rewrite an existing line through its API."
 * That is a claim about the module's SURFACE, so it is asserted about the
 * surface as well as about the behaviour — a behavioural test can only cover
 * the calls someone thought to make.
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
    // If any of these ever appears, the one invariant this module exists to
    // hold has been lost, and this is the alarm.
    const surface = Object.keys(log);
    for (const forbidden of ['logSet', 'logReplace', 'logDelete', 'logEdit', 'logTruncate']) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface).toEqual(expect.arrayContaining(['logAppend', 'logInit', 'logFile']));
  });
});

describe('logInit', () => {
  it('writes the heading once and never touches an existing file', () => {
    log.logInit('t042', 'unify the auth header');
    const file = log.logFile('t042');
    expect(readFileSync(file, 'utf8')).toBe('# t042 unify the auth header\n\n');

    log.logAppend('t042', 'first event', '08-04');
    log.logInit('t042', 'a completely different title');
    expect(readFileSync(file, 'utf8')).toBe(
      '# t042 unify the auth header\n\n- 08-04  first event\n',
    );
  });

  it('writes a bare heading when there is no title', () => {
    log.logInit('t043');
    expect(readFileSync(log.logFile('t043'), 'utf8')).toBe('# t043\n\n');
  });
});

describe('logAppend', () => {
  it('adds one line at the end and leaves every earlier line alone', () => {
    log.logInit('t042', 'x');
    log.logAppend('t042', 's1 auth  parse the header', '08-04');
    log.logAppend('t042', 's2 auth  → !31 merged', '08-05');

    expect(readFileSync(log.logFile('t042'), 'utf8')).toBe(
      '# t042 x\n\n- 08-04  s1 auth  parse the header\n- 08-05  s2 auth  → !31 merged\n',
    );
  });

  it('creates the log when it is missing, so a caller cannot forget to', () => {
    log.logAppend('t077', 'straight to the log', '08-04');
    expect(readFileSync(log.logFile('t077'), 'utf8')).toBe('# t077\n\n- 08-04  straight to the log\n');
  });

  it('refuses a multi-line entry, which would forge a second event', () => {
    expect(() => log.logAppend('t042', 'one\ntwo')).toThrow(YanError);
  });

  it('refuses empty arguments', () => {
    expect(() => log.logAppend('', 'text')).toThrow(YanError);
    expect(() => log.logAppend('t042', '')).toThrow(YanError);
  });

  it('defaults the date to today as MM-DD', () => {
    log.logAppend('t042', 'dated by default');
    const line = readFileSync(log.logFile('t042'), 'utf8').trim().split('\n').pop() ?? '';
    expect(line).toMatch(/^- \d{2}-\d{2} {2}dated by default$/);
  });
});
