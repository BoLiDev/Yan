import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { sendLine, type Prompter } from '../../src/cli/send.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan send`, ported from `tests/unit/yan-send.test.sh` and the send half of
 * `tests/integration/yan-send-state.test.sh`.
 *
 * The mvp's assertions were about a two-step: type the text, then press Enter,
 * retryable separately. Herdr's `agent prompt` does both in one call, so that
 * split and its `--enter` / `--no-enter` flags are gone (orchestration.md §5)
 * and what is pinned instead is the guard that replaced them:
 *
 *   Nothing is sent to a pane without a live agent.
 *
 * A recording stand-in stands where the seam does, so "one call, with exactly
 * this text" is an exact assertion rather than an eyeball on a pane. What the
 * seam itself does with the call is `src/externals/herdr/terminal.test.ts` and
 * `tests/e2e/terminal-herdr.test.ts`.
 */

afterAll(cleanupTempDirs);

let home = '';
let run = '';
let previousHome: string | undefined;

class RecordingTerminal implements Prompter {
  public readonly calls: { pane: string; text: string }[] = [];
  public refuse: Error | undefined;

  public send(pane: string, text: string): void {
    if (this.refuse !== undefined) throw this.refuse;
    this.calls.push({ pane, text });
  }
}

let terminal: RecordingTerminal;

function meta(body: Record<string, unknown>): void {
  writeFileSync(join(run, 'meta.json'), `${JSON.stringify({ version: 1, ...body })}\n`);
}

function send(sid: string, line?: string): { code: number; message: string } {
  try {
    sendLine(sid, line, 't042', terminal);
    return { code: 0, message: '' };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir(), { withDist: true });
  process.env.YAN_HOME = home;
  Task.create('t042', 'unify the auth header');

  run = join(home, 'tasks', 't042', 'shifts', 's3', 'run');
  mkdirSync(run, { recursive: true });
  meta({ unit: 'auth', branch: 'yan/t042/s3', agent: 'claude', pane: 'w1:p7' });
  terminal = new RecordingTerminal();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  delete process.env.YAN_SEND_MAX;
});

describe('one call, carrying the line as it stands', () => {
  it('sends the text and the Enter together', () => {
    const r = send('s3', 'check the failing test first');
    expect(r.code, r.message).toBe(0);
    expect(terminal.calls).toEqual([{ pane: 'w1:p7', text: 'check the failing test first' }]);
  });
});

describe('one short line only', () => {
  it('refuses a newline, and nothing reaches the terminal', () => {
    const r = send('s3', 'two\nlines');
    expect(r.code, 'a newline is not one line').toBe(2);
    expect(r.message).toContain('file');
    expect(terminal.calls).toEqual([]);
  });

  it('refuses a line longer than the limit, and says how long it was', () => {
    const long = 'x'.repeat(501);
    const r = send('s3', long);
    expect(r.code, 'anything long goes in a file and only the path is sent').toBe(2);
    expect(r.message).toContain('501 characters');
    expect(terminal.calls).toEqual([]);
  });

  it('treats the limit as a knob, not a law of nature', () => {
    process.env.YAN_SEND_MAX = '600';
    expect(send('s3', 'x'.repeat(501)).code).toBe(0);
  });

  it('refuses an empty line', () => {
    expect(send('s3', '').code).toBe(2);
    expect(terminal.calls).toEqual([]);
  });
});

describe('the pane id comes from meta.json, and it is an id', () => {
  it('refuses a label rather than looking a shift up by one', async () => {
    // The seam is what enforces this; the command must not work around it.
    meta({ agent: 'claude', pane: 's3-auth' });
    const real = await runYan(home, ['send', 's3', 'hello', '--task', 't042']);
    expect(real.code).not.toBe(0);
    expect(real.out, 'a label is not a source of truth').toContain('never a label');
  });

  it('reports a missing terminal id rather than silently doing nothing', () => {
    meta({ agent: 'claude' });
    const r = send('s3', 'hello');
    expect(r.code).toBe(1);
    expect(r.message).toContain('no terminal id');
    expect(terminal.calls).toEqual([]);
  });
});

describe('a pane with no live agent', () => {
  it('is refused by the seam, and the refusal reaches the caller', () => {
    // evidence §11.7: a prompt to a pane whose agent has died is typed into
    // whatever shell is there, which then tries to run it as a command. A dead
    // shift is a `died:` wake, not a retry.
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
    expect((await runYan(home, ['send', 's3', '--task', 't042'])).code, 'a line is required').toBe(2);
    expect((await runYan(home, ['send', 'nosuchshift', 'hello', '--task', 't042'])).code).toBe(1);
  });

  it('no longer offers --enter or --no-enter', async () => {
    // Herdr's `agent prompt` submits text and Enter in one call, so the two-step
    // has nothing left to do. A flag that silently did nothing would be worse
    // than one that is gone.
    // The help text still names them, to say they are gone. What must not
    // exist is the option itself.
    const options = /Options:\n([\s\S]*?)\n\n/.exec((await runYan(home, ['send', '--help'])).out)?.[1] ?? '';
    expect(options).not.toContain('--no-enter');
    expect(options).not.toContain('--enter');
    expect((await runYan(home, ['send', 's3', '--enter', '--task', 't042'])).code).not.toBe(0);
  });
});
