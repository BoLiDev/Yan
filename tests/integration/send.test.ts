import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { attempt, type Attempt, liveShift, seedT042 } from '../helpers/records.js';
import { sendLine, type Prompter } from '../../src/cli/send.js';

/**
 * `yan send`. Text and Enter go in one call, so what is pinned here is the
 * guard: nothing is sent to a pane without a live agent.
 *
 * A recording stand-in stands where the seam does, so "one call, with exactly
 * this text" is an exact assertion.
 */

afterAll(cleanupTempDirs);

let home = '';
let run = '';

class RecordingTerminal implements Prompter {
  public readonly calls: { pane: string; text: string }[] = [];
  public refuse: Error | undefined;

  public send(pane: string, text: string): void {
    if (this.refuse !== undefined) throw this.refuse;
    this.calls.push({ pane, text });
  }
}

let terminal: RecordingTerminal;

function send(sid: string, line?: string): Attempt<unknown> {
  return attempt(() => sendLine(sid, line, 't042', terminal));
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  seedT042(null);

  run = liveShift(home, 't042', 's3', { unit: 'auth', branch: 'yan/t042/s3', agent: 'claude', pane: 'w1:p7' });
  terminal = new RecordingTerminal();
});

afterEach(() => {
  delete process.env.YAN_SEND_MAX;
});

describe('one call, carrying the line as it stands', () => {
  it('sends the text and the Enter together', () => {
    const r = send('s3', 'check the failing test first');
    expect(r.code, r.message).toBe(0);
    expect(terminal.calls).toEqual([{ pane: 'w1:p7', text: 'check the failing test first' }]);
  });
});

describe('one line, up to 1000 characters', () => {
  it('refuses a newline, and nothing reaches the terminal', () => {
    const r = send('s3', 'two\nlines');
    expect(r.code, 'a newline is not one line').toBe(2);
    expect(r.message).toContain('file');
    expect(terminal.calls).toEqual([]);
  });

  it('refuses a line longer than the limit, and says how long it was', () => {
    expect(send('s3', 'x'.repeat(1000)).code, 'a long paragraph is fine').toBe(0);
    terminal.calls.length = 0;
    const long = 'x'.repeat(1001);
    const r = send('s3', long);
    expect(r.code, 'anything long goes in a file and only the path is sent').toBe(2);
    expect(r.message).toContain('1001 characters');
    expect(terminal.calls).toEqual([]);
  });

  it('treats the limit as a knob, not a law of nature', () => {
    process.env.YAN_SEND_MAX = '1200';
    expect(send('s3', 'x'.repeat(1001)).code).toBe(0);
  });

  it('refuses an empty line', () => {
    expect(send('s3', '').code).toBe(2);
    expect(terminal.calls).toEqual([]);
  });
});

describe('the pane id comes from meta.json, and it is an id', () => {
  it('refuses a label rather than looking a shift up by one', async () => {
    // The seam is what enforces this; the command must not work around it.
    liveShift(home, 't042', 's3', { agent: 'claude', pane: 's3-auth' });
    const real = await runYan(home, ['send', 's3', 'hello'], { YAN_TASK: 't042' });
    expect(real.code).not.toBe(0);
    expect(real.out, 'a label is not a source of truth').toContain('never a label');
  });

  it('reports a missing terminal id rather than silently doing nothing', () => {
    liveShift(home, 't042', 's3', { agent: 'claude' });
    const r = send('s3', 'hello');
    expect(r.code).toBe(1);
    expect(r.message).toContain('no terminal id');
    expect(terminal.calls).toEqual([]);
  });
});

describe('a pane with no live agent', () => {
  it('is refused by the seam, and the refusal reaches the caller', () => {
    // Text sent to a pane whose agent has died is typed into whatever shell is
    // there, which then tries to run it.
    terminal.refuse = Object.assign(new Error('no live agent in w1:p7 - refusing to send'), {
      exitCode: 1,
    });
    const r = send('s3', 'anyone there?');
    expect(r.code).not.toBe(0);
    expect(r.message).toContain('no live agent');
  });
});

describe('a shift that has clocked out has no terminal', () => {
  it('says so, and never reaches the seam', () => {
    rmSync(run, { recursive: true, force: true });
    const r = send('s3', 'hello');
    expect(r.code).toBe(1);
    expect(r.message).toContain('clocked out');
    expect(terminal.calls).toEqual([]);
  });
});

describe('usage', () => {
  it('needs a shift id and a line, and an unknown shift is an error', async () => {
    expect((await runYan(home, ['send'])).code).toBe(2);
    expect((await runYan(home, ['send', 's3'], { YAN_TASK: 't042' })).code, 'a line is required').toBe(2);
    expect((await runYan(home, ['send', 'nosuchshift', 'hello'], { YAN_TASK: 't042' })).code).toBe(1);
  });

  it('no longer offers --enter or --no-enter', async () => {
    // Text and Enter go in one call, so there is no `--enter` / `--no-enter`.
    // The help text names them only to say they are gone.
    const options = /Options:\n([\s\S]*?)\n\n/.exec((await runYan(home, ['send', '--help'])).out)?.[1] ?? '';
    expect(options).not.toContain('--no-enter');
    expect(options).not.toContain('--enter');
    expect((await runYan(home, ['send', 's3', '--enter'], { YAN_TASK: 't042' })).code).not.toBe(0);
  });
});
