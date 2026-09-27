import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bashCommand, cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { seedT042 } from '../helpers/records.js';
import { reportEvent, noteForYan } from '../../src/cli/report.js';
import { YanError } from '../../src/util/error.js';
import type { ReportDeps, ReportTerminal } from '../../src/cli/report.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan report`. Two halves, and both are checked: the line it appends to
 * `run/status`, which is the persistent fact, and the line it types into
 * yan's pane, which is the whole of how yan hears anything.
 *
 * A recording stand-in stands where the terminal does, so "one call, with
 * exactly this text" is an exact assertion; the paths that go through
 * `bin/yan` deliver nothing, because no yan holds the enter lock, and the
 * retry knobs keep that from costing thirty seconds a call.
 */

afterAll(cleanupTempDirs);

let home = '';
let run = '';

/** The real CLI, with the retries turned down: nothing here waits on a pane. */
function yan(args: readonly string[], env: Record<string, string> = {}) {
  return runYan(home, args, { YAN_REPORT_TRIES: '1', YAN_REPORT_PAUSE_MS: '0', ...env });
}

function lines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').length;
}

function status(): string {
  return existsSync(join(run, 'status')) ? readFileSync(join(run, 'status'), 'utf8') : '';
}

beforeAll(async () => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  seedT042();
  Task.create('t007', 'retire the legacy client');

  run = join(home, 'tasks', 't042', 'shifts', 's1', 'run');
  mkdirSync(join(home, 'tasks', 't042', 'shifts', 's1'), { recursive: true });
  mkdirSync(join(home, 'tasks', 't007', 'shifts', 's1'), { recursive: true });
  writeFileSync(join(home, 'tasks', 't042', 'shifts', 's1', 'outcome.md'), '# s1 auth\n\nResult: parsed.\n');
  writeFileSync(join(home, 'tasks', 't007', 'shifts', 's1', 'outcome.md'), '# s1\n');
});

describe('the event is recorded, and nothing else is left beside it', () => {
  it('appends one timestamped line, state in its own field', async () => {
    expect(existsSync(join(run, 'status'))).toBe(false);

    const r = await yan(['report', 'done', 'mr https://forge.invalid/x/-/merge_requests/1', '--sid', 's1'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(lines(join(run, 'status'))).toBe(1);

    const first = status().split('\n')[0] ?? '';
    expect(first, 'the state is its own field').toContain('\tdone\t');
    expect(first, 'the note is kept verbatim').toContain('merge_requests/1');
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it('writes no wake marker: there is nothing left to notice one', async () => {
    await yan(['report', 'blocked', 'waiting for a credential', '--sid', 's1'], { YAN_TASK: 't042' });
    expect(existsSync(join(run, 'signal')), 'run/signal is gone from the design').toBe(false);
    expect(lines(join(run, 'status')), 'run/status is appended, never replaced').toBe(2);
    expect(status(), 'the earlier event survived').toContain('merge_requests/1');
  });
});

describe('exactly five states', () => {
  it('accepts the other three', async () => {
    for (const state of ['started', 'needs-decision', 'conflict']) {
      const r = await yan(['report', state, `note for ${state}`, '--sid', 's1'], { YAN_TASK: 't042' });
      expect(r.code, `${state} must be accepted: ${r.out}`).toBe(0);
    }
    expect(lines(join(run, 'status')), 'all five allowed states were accepted').toBe(5);
  });

  it('refuses a sixth word loudly, and writes nothing at all', async () => {
    const before = status();
    for (const bad of ['progress', 'DONE', 'finished', 'failed', 'stuck', 'note', '']) {
      const r = await yan(['report', bad, 'a note', '--sid', 's1'], { YAN_TASK: 't042' });
      expect(r.code, `'${bad}' is not one of the five and must be refused loudly`).toBe(2);
      expect(r.out, 'the refusal names the whole allowed set').toContain('started done blocked needs-decision conflict');
    }
    expect(status(), 'a refused state writes nothing at all').toBe(before);
  });
});

describe('a note is required, and it is one line', () => {
  it('refuses a state with no note, and a note with a newline in it', async () => {
    const before = status();
    expectUsage(await yan(['report', 'done', '--sid', 's1'], { YAN_TASK: 't042' }), 'a note is required');

    // Built inside bash: on Windows a literal newline in argv is re-split
    // before it reaches the process, which would test the harness.
    const r = spawnSync(
      bashCommand(),
      ['-c', `bash "$1" report done $'two\\nlines' --sid s1`, '_', join(home, 'bin', 'yan')],
      { encoding: 'utf8', env: { ...process.env, YAN_HOME: home, YAN_TASK: 't042', YAN_REPORT_TRIES: '1' }, windowsHide: true },
    );
    expect(r.status, 'a newline would forge a second event').toBe(2);
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('one line');
    expect(status()).toBe(before);
  });

  it('refuses a note too long for one submission, and writes nothing', async () => {
    // The note goes into a pane, so it takes the limit `yan send` takes.
    const before = status();
    const r = await yan(['report', 'blocked', 'x'.repeat(1200), '--sid', 's1'], { YAN_TASK: 't042' });
    expectUsage(r, 'the limit is 1000');
    expect(status()).toBe(before);
  });
});

describe('who is reporting: the spawn environment, not an argument', () => {
  it('reads all three spellings', async () => {
    const shiftDir = join(home, 'tasks', 't042', 'shifts', 's1');
    const before = lines(join(run, 'status'));
    expect((await yan(['report', 'done', 'via YAN_SHIFT_DIR'], { YAN_SHIFT_DIR: shiftDir })).code).toBe(0);
    expect(lines(join(run, 'status'))).toBe(before + 1);

    expect((await yan(['report', 'done', 'via YAN_TASK_DIR as the shift dir'], { YAN_TASK_DIR: shiftDir })).code).toBe(0);
    expect(
      (await yan(['report', 'done', 'via YAN_TASK_DIR plus YAN_SID'], {
        YAN_TASK_DIR: join(home, 'tasks', 't042'),
        YAN_SID: 's1',
      })).code,
    ).toBe(0);
    expect((await yan(['report', 'done', 'via ids only'], { YAN_TASK: 't042', YAN_SID: 's1' })).code).toBe(0);
    expect(lines(join(run, 'status'))).toBe(before + 4);
  });

  it("does not take the main agent's task directory for a shift's", async () => {
    // The main agent gets YAN_TASK and YAN_TASK_DIR and no YAN_SID, and a task
    // directory has a `run/` folder of its own, just as a shift's does.
    const taskDir = join(home, 'tasks', 't042');
    mkdirSync(join(taskDir, 'run'), { recursive: true });
    writeFileSync(join(taskDir, 'outcome.md'), 'not a shift\n');
    const before = lines(join(run, 'status'));

    const r = await yan(['report', 'done', 'yan is not a shift'], {
      YAN_TASK: 't042',
      YAN_TASK_DIR: taskDir,
      YAN_SID: '',
      YAN_SHIFT_DIR: '',
    });
    expectUsage(r, 'YAN_SHIFT_DIR');
    expect(existsSync(join(taskDir, 'run', 'status')), 'nothing was written to the task').toBe(false);
    expect(lines(join(run, 'status')), "and nothing to a shift's").toBe(before);

    rmSync(join(taskDir, 'run'), { recursive: true, force: true });
    rmSync(join(taskDir, 'outcome.md'), { force: true });
  });

  it('says so rather than guessing when nothing identifies the shift', async () => {
    const r = await yan(['report', 'done', 'nobody knows who I am'], {
      YAN_SHIFT_DIR: '',
      YAN_TASK_DIR: '',
      YAN_TASK: '',
      YAN_SID: '',
    });
    expectUsage(r, 'YAN_SHIFT_DIR');
  });

  it('refuses an id that exists under two tasks rather than guessing at it', async () => {
    const r = await yan(['report', 'done', 'ambiguous'], {
      YAN_SID: 's1',
      YAN_TASK: '',
      YAN_TASK_DIR: '',
      YAN_SHIFT_DIR: '',
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('$YAN_TASK');
  });
});

describe('done waits for the handover', () => {
  const dir = () => join(home, 'tasks', 't042', 'shifts', 's2');

  it('refuses done while outcome.md is missing, names the file, and writes nothing', async () => {
    mkdirSync(dir(), { recursive: true });
    const r = await yan(['report', 'done', 'mr https://forge.invalid/x/-/merge_requests/2', '--sid', 's2'], { YAN_TASK: 't042' });
    expectUsage(r, 'outcome.md');
    expect(existsSync(join(dir(), 'run', 'status')), 'no event').toBe(false);
    expect(existsSync(join(dir(), 'run', 'undelivered')), 'and nothing kept for yan to read').toBe(false);
  });

  it('still takes every other state without one', async () => {
    for (const state of ['started', 'blocked', 'needs-decision', 'conflict']) {
      const r = await yan(['report', state, `note for ${state}`, '--sid', 's2'], { YAN_TASK: 't042' });
      expect(r.code, `${state}: ${r.out}`).toBe(0);
    }
  });

  it('takes done once the file exists', async () => {
    writeFileSync(join(dir(), 'outcome.md'), '# s2 auth\n\nResult: done.\n');
    const r = await yan(['report', 'done', 'mr https://forge.invalid/x/-/merge_requests/2', '--sid', 's2'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(dir(), 'run', 'status'), 'utf8')).toContain('\tdone\t');
  });
});

/**
 * The delivery, driven in process: the recording terminal is where Herdr
 * would be, and the pane lookup is where the task's enter lock would be.
 */
describe('the note is typed into yan\'s pane', () => {
  const RULE = '─'.repeat(40);

  /** A Claude Code screen whose prompt box holds `typed`. */
  function screenWith(typed: string): string {
    return ['⏺ thinking', RULE, `❯ ${typed}`.trimEnd(), RULE, '  esc to interrupt', ''].join('\n');
  }

  class RecordingTerminal implements ReportTerminal {
    public readonly calls: { pane: string; text: string }[] = [];
    /** Thrown on the first `refuseTimes` calls, then it succeeds. */
    public refuseTimes = 0;
    public refusal: Error = new Error('agent prompt: agent_blocked');
    /** What each successive `read` shows; the last one repeats. */
    public screens: string[] = [screenWith('')];
    public reads = 0;
    /** What Herdr says runs in the pane. */
    public kind: string | undefined = 'claude';

    public read(): string {
      this.reads += 1;
      return this.screens[Math.min(this.reads, this.screens.length) - 1] ?? '';
    }

    public agentKind(): string | undefined {
      return this.kind;
    }

    public send(pane: string, text: string): void {
      if (this.refuseTimes > 0) {
        this.refuseTimes -= 1;
        throw this.refusal;
      }
      this.calls.push({ pane, text });
    }
  }

  let deliveryHome = '';
  let terminal: RecordingTerminal;
  let slept: number[];
  let pane: string | undefined;
  let shiftRun = '';

  function deps(): ReportDeps {
    return { terminal, paneOf: () => pane, sleep: (ms) => slept.push(ms) };
  }

  function report(state: string, note: string, sid = 's3'): void {
    reportEvent(state, note, { sid }, deps());
  }

  function undelivered(): string {
    const file = join(shiftRun, 'undelivered');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  beforeEach(async () => {
    deliveryHome = mkYanHome(mkTempDir(), { withDist: true });
    process.env.YAN_TASK = 't042';
    process.env.YAN_REPORT_TRIES = '5';
    process.env.YAN_REPORT_PAUSE_MS = '7000';
    process.env.YAN_REPORT_TYPING_WAIT_MS = '30000';
    process.env.YAN_REPORT_TYPING_POLL_MS = '10000';
    seedT042(null);

    shiftRun = join(deliveryHome, 'tasks', 't042', 'shifts', 's3', 'run');
    mkdirSync(shiftRun, { recursive: true });
    writeFileSync(join(deliveryHome, 'tasks', 't042', 'shifts', 's3', 'outcome.md'), '# s3\n');
    terminal = new RecordingTerminal();
    slept = [];
    pane = 'w1:p4';
  });

  afterEach(() => {
    delete process.env.YAN_TASK;
    delete process.env.YAN_REPORT_TRIES;
    delete process.env.YAN_REPORT_PAUSE_MS;
    delete process.env.YAN_REPORT_TYPING_WAIT_MS;
    delete process.env.YAN_REPORT_TYPING_POLL_MS;
  });

  it('sends the note as it stands, with the sid appended when it is missing', () => {
    report('blocked', 'the auth fixture needs a credential I do not have');
    expect(terminal.calls).toEqual([
      { pane: 'w1:p4', text: 'the auth fixture needs a credential I do not have (s3)' },
    ]);
  });

  it('adds nothing at all when the note already names the shift', () => {
    report('done', 's3 is done: mr https://forge.invalid/x/1');
    expect(terminal.calls[0]?.text).toBe('s3 is done: mr https://forge.invalid/x/1');
  });

  it('is not fooled by another shift\'s id inside the note', () => {
    // `s3` is not in `s30`, so the tag still goes on: a note about another
    // shift must not stand in for this one's name.
    expect(noteForYan('s30 merged first', 's3')).toBe('s30 merged first (s3)');
    expect(noteForYan('handed over to s3, taking the next round', 's3')).toBe(
      'handed over to s3, taking the next round',
    );
  });

  it('carries no prefix and no state word: the note is what yan reads', () => {
    report('needs-decision', 'which target branch should the outbound MR aim at?');
    const text = terminal.calls[0]?.text ?? '';
    expect(text.startsWith('which target branch')).toBe(true);
    expect(text).not.toContain('needs-decision');
    expect(text).not.toContain('[shift');
  });

  it('records `started` and sends nothing', () => {
    report('started', 'read the brief');
    expect(terminal.calls).toEqual([]);
    expect(readFileSync(join(shiftRun, 'status'), 'utf8')).toContain('\tstarted\t');
    expect(undelivered(), 'and started never lands in undelivered either').toBe('');
  });

  it('retries a refusal and keeps the report when the pane frees up', () => {
    terminal.refuseTimes = 2;
    report('blocked', 'waiting on a credential');
    expect(terminal.calls, 'the third attempt landed').toHaveLength(1);
    expect(slept, 'and it waited between attempts').toEqual([7000, 7000]);
    expect(undelivered(), 'nothing is kept once it arrives').toBe('');
  });

  it('gives up after five attempts and keeps the line for yan to find', () => {
    terminal.refuseTimes = 99;
    report('conflict', 'the merge into the integration branch conflicts in src/cli/state.ts');
    expect(terminal.calls).toEqual([]);
    expect(slept, 'five attempts, four pauses, about thirty seconds').toHaveLength(4);

    const kept = undelivered().trim();
    expect(kept).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\tconflict\tthe merge into the integration branch conflicts in src\/cli\/state\.ts$/);
    expect(readFileSync(join(shiftRun, 'status'), 'utf8'), 'the event was recorded either way').toContain('\tconflict\t');
  });

  it('keeps it when no yan is running, without ever asking the terminal', () => {
    pane = undefined;
    report('needs-decision', 'which branch?');
    expect(terminal.calls).toEqual([]);
    expect(undelivered()).toContain('\tneeds-decision\twhich branch?\n');
  });

  it('appends, so two reports nobody heard are both there', () => {
    pane = undefined;
    report('blocked', 'first');
    report('conflict', 'second');
    expect(undelivered().trim().split('\n')).toHaveLength(2);
  });

  describe("user's own half-typed line is never submitted with the note", () => {
    it('looks at the screen first, and sends at once when the prompt box is empty', () => {
      report('done', 'mr https://x/1');
      expect(terminal.reads).toBe(1);
      expect(terminal.calls).toHaveLength(1);
      expect(slept).toEqual([]);
    });

    it('waits while user is typing, and sends once the box clears', () => {
      terminal.screens = [screenWith('merge it an'), screenWith('merge it and run'), screenWith('')];
      report('blocked', 'the build is red');
      expect(terminal.reads).toBe(3);
      expect(slept).toEqual([10000, 10000]);
      expect(terminal.calls).toHaveLength(1);
      expect(status()).toContain('blocked');
    });

    it('gives up after the wait with exit 3, and records nothing at all', () => {
      terminal.screens = [screenWith('still typing')];
      let caught: unknown;
      try {
        report('needs-decision', 'which branch?');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(YanError);
      expect((caught as YanError).code).toBe('report_user_typing');
      expect((caught as YanError).exitCode).toBe(3);
      expect((caught as YanError).message).toContain('again in a minute');
      // Three looks over thirty seconds, two pauses between them.
      expect(terminal.reads).toBe(3);
      expect(slept).toEqual([10000, 10000]);
      expect(terminal.calls).toHaveLength(0);
      expect(existsSync(join(shiftRun, 'status'))).toBe(false);
      expect(undelivered()).toBe('');
    });

    it('holds nothing when the screen shows no prompt box: a dialog is delivery\'s problem', () => {
      terminal.screens = [['⏺', RULE, '  Do you want to proceed?', '  ❯ 1. Yes', RULE, ''].join('\n')];
      terminal.refuseTimes = 1;
      report('conflict', 'merge conflict in a.ts');
      expect(slept).toEqual([7000]);
      expect(terminal.calls).toHaveLength(1);
    });

    it('reads a codex prompt box too, placeholder and all', () => {
      const composer = (entry: string): string => ['• Done.', '', `\x1b[1m›\x1b[0m ${entry}`, '', '  GPT-6-Luna default · ~/p', ''].join('\n');
      terminal.kind = 'codex';
      terminal.screens = [composer('half a thou'), composer('\x1b[2mAsk Codex to do anything\x1b[0m')];
      report('done', 'mr https://x/3');
      expect(terminal.reads).toBe(2);
      expect(slept).toEqual([10000]);
      expect(terminal.calls).toHaveLength(1);
    });

    it('holds nothing under a harness whose prompt box it cannot read', () => {
      terminal.kind = 'agy';
      terminal.screens = [screenWith('typing')];
      report('done', 'mr https://x/4');
      expect(terminal.reads).toBe(1);
      expect(slept).toEqual([]);
      expect(terminal.calls).toHaveLength(1);
    });

    it('does not look at all for `started`, or when no yan is running', () => {
      terminal.screens = [screenWith('typing')];
      report('started', 'read the brief');
      expect(terminal.reads).toBe(0);
      pane = undefined;
      report('done', 'mr https://x/2');
      expect(terminal.reads).toBe(0);
      expect(undelivered()).toContain('done');
    });
  });
});
