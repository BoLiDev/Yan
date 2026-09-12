import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Terminal } from './index.js';
import * as term from './index.js';
import { herdrErrorCode, mapError } from './cli.js';
import { AGENT_STATUS, HERDR_PROTOCOL } from './schema.js';
import { TerminalError } from './errors.js';
import { repoRoot } from '../../../tests/helpers/fixtures.js';

/**
 * The terminal seam's contract, true whether or not Herdr is installed: the
 * id rules, the "cannot close what yan did not create" promise, and the closed
 * set `agentAlive` answers with.
 */

const moduleDir = join(repoRoot, 'src', 'externals', 'herdr');

/**
 * The seam with its comments stripped: the greps below are about what the code
 * does, and the same strings are named in prose above them.
 */
function seamSource(): string {
  return readdirSync(moduleDir)
    // Not this file, which names every forbidden string as a literal.
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(moduleDir, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('ids are used, nothing is located by label alone', () => {
  // A name is cleared when its agent exits, so it cannot identify a shift that
  // has died — which is exactly what supervision has to do.
  const notPaneIds = ['yan', 's3-auth', '', '@3', '%7', 'w1', 'w1:t1', '3', 'w1:p'];

  it.each(notPaneIds)('send refuses %j', (bad) => {
    let thrown: unknown;
    try {
      new Terminal().send(bad, 'hello');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TerminalError);
    expect((thrown as TerminalError).exitCode).toBe(2);
    expect((thrown as TerminalError).message).toContain('never a label');
  });

  it.each(notPaneIds)('read / agentAlive / close refuse %j', (bad) => {
    for (const call of [
      () => new Terminal().read(bad),
      () => new Terminal().agentAlive(bad),
      () => new Terminal().close(bad),
    ]) {
      let thrown: unknown;
      try {
        call();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TerminalError);
      expect((thrown as TerminalError).exitCode).toBe(2);
    }
  });

  it.each(['mysession', 't042', '', 'w1:p1', '$0', '%7'])(
    'list refuses the container name %j',
    (bad) => {
      let thrown: unknown;
      try {
        new Terminal().list(bad === '' ? 'not-a-workspace' : bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TerminalError);
      expect((thrown as TerminalError).message).toContain('never a name');
    },
  );

  it('a well-formed pane id gets past the guard', () => {
    // It then fails on Herdr, not on parsing — so it must not be a usage error.
    let thrown: unknown;
    try {
      new Terminal().read('w9:p99');
    } catch (e) {
      thrown = e;
    }
    if (thrown !== undefined) {
      expect((thrown as TerminalError).exitCode).not.toBe(2);
    }
  });
});

describe('usage errors', () => {
  it('are exit 2, which means you called this wrongly', () => {
    expect(() => new Terminal().createContainer('')).toThrow(TerminalError);
    expect(() => new Terminal().read('w1:p1', 0)).toThrow(/whole number of lines/);
    expect(() => new Terminal().send('w1:p1', '')).toThrow(/nothing to send/);
    expect(() =>
      new Terminal().startAgent({ container: 'w1', name: 'Bad Name', kind: 'claude', cwd: '.' }),
    ).toThrow(/agent name/);
    expect(() =>
      new Terminal().startAgent({ container: 'w1', name: 'ok', kind: '', cwd: '.' }),
    ).toThrow(/agent kind/);
    expect(() =>
      new Terminal().startAgent({ container: 'w1', name: 'ok', kind: 'claude', cwd: '' }),
    ).toThrow(/working directory/);
  });
});

describe('the seam cannot close what yan did not create', () => {
  const source = seamSource();

  it('never spells workspace close or tab close', () => {
    // The two verbs that would close a container appear nowhere in the seam.
    expect(source).not.toMatch(/'workspace',\s*'close'/);
    expect(source).not.toMatch(/'tab',\s*'close'/);
    expect(source).not.toContain('server stop');
    expect(source).not.toMatch(/'server',\s*'stop'/);
  });

  it('closes exactly one pane', () => {
    expect(source).toMatch(/'pane',\s*'close'/);
  });
});

describe('yan never calls agent focus on a shift pane', () => {
  const source = seamSource();

  it('the string is absent from the seam', () => {
    // Focusing marks the tab seen, which turns the `done` yan was about to be
    // woken by into an `idle` it ignores.
    expect(source).not.toMatch(/'agent',\s*'focus'/);
    expect(source).not.toContain('agent focus');
    expect(source).not.toMatch(/'workspace',\s*'focus'/);
    expect(source).not.toMatch(/'pane',\s*'focus'/);
  });

  it('and --no-focus is passed where focus could move', () => {
    expect(source).toContain("'--no-focus'");
    expect(source).not.toContain("'--focus'");
  });
});

describe('the deletions this phase earns are real', () => {
  const source = seamSource();

  it('winpty appears nowhere', () => {
    expect(source).not.toContain('winpty');
  });

  it('--current is never passed', () => {
    // It resolves through HERDR_PANE_ID, and a hook may be handed a sanitised
    // environment.
    expect(source).not.toContain("'--current'");
  });

  it('there is no command quoting left to do', () => {
    expect(source).not.toContain('quote');
  });
});

describe('no Herdr error code escapes the seam', () => {
  it('maps the ones yan knows and refuses to leak the rest', () => {
    const notFound = mapError(
      { code: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found","message":"x"}}' },
      'agent get',
    );
    expect(notFound.code).toBe(TerminalError.codes.notFound);

    const refused = mapError(
      { code: 1, stdout: '', stderr: '{"error":{"code":"workspace_full","message":"x"}}' },
      'pane split',
    );
    expect(refused.code).toBe(TerminalError.codes.refused);

    // The one refusal that is about timing rather than a verdict.
    // What herdr 0.8 really says, and the bare spelling beside it.
    for (const herdrCode of ['agent_pane_busy', 'pane_busy']) {
      const busy = mapError(
        { code: 1, stdout: '', stderr: `{"error":{"code":"${herdrCode}","message":"x"}}` },
        'agent start',
      );
      expect(busy.code, herdrCode).toBe(TerminalError.codes.busy);
    }

    // rc 2 is a CLI syntax error - a bug in yan, never a runtime condition.
    expect(mapError({ code: 2, stdout: '', stderr: 'usage: …' }, 'pane split').code).toBe(
      TerminalError.codes.bug,
    );

    // rc 1 with no structured error is a transport problem, not a verdict.
    expect(mapError({ code: 1, stdout: '', stderr: 'boom' }, 'agent list').code).toBe(
      TerminalError.codes.unreachable,
    );
    expect(mapError({ code: 127, stdout: '', stderr: 'no herdr' }, 'agent list').code).toBe(
      TerminalError.codes.unreachable,
    );

    for (const code of ['term_not_found', 'term_refused', 'term_bug', 'term_unreachable']) {
      expect(code.startsWith('term_')).toBe(true);
    }
  });

  it('reads error.code out of stderr and ignores prose around it', () => {
    expect(herdrErrorCode('warning: preview build\n{"error":{"code":"pane_not_found"}}')).toBe(
      'pane_not_found',
    );
    expect(herdrErrorCode('just prose')).toBeUndefined();
  });
});

describe('alive is a closed set of three words', () => {
  it('and unknown is never rounded up to alive', () => {
    // The one verdict that is hard to produce on a healthy machine: make herdr
    // unreachable and the honest answer is that we cannot tell.
    const path = process.env.PATH;
    process.env.PATH = join(repoRoot, 'no-such-directory');
    try {
      expect(new Terminal().agentAlive('w9:p99')).toBe('unknown');
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });
});

describe('the generated types', () => {
  it('carry the protocol they were generated against', () => {
    expect(HERDR_PROTOCOL).toBeGreaterThan(0);
    expect(term.HERDR_PROTOCOL).toBe(HERDR_PROTOCOL);
  });

  it('name every agent state the design table lists', () => {
    expect([...AGENT_STATUS].sort()).toEqual(['blocked', 'done', 'idle', 'unknown', 'working']);
  });

  it('are generated, and say so', () => {
    const generated = readFileSync(join(moduleDir, 'schema.ts'), 'utf8');
    expect(generated.startsWith('// GENERATED')).toBe(true);
  });
});

describe('an agent that is not really there', () => {
  const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify({ result: body }), stderr: '' });
  const agentGone = {
    code: 1,
    stdout: '',
    stderr: '{"error":{"code":"agent_not_found","message":"x"}}',
  };

  /**
   * A herdr that answers `tab create` and `agent start` happily and reports
   * the agent ready, with no agent in that pane — what a CLI that exited at
   * once looks like, since the bare shell prompt it left behind matches too.
   */
  function pretendingHerdr(alive: boolean) {
    return (args: readonly string[]) => {
      const verb = `${args[0]} ${args[1]}`;
      // A new tab comes with exactly one pane, and Herdr reports it as
      // `root_pane`. That is the pane the agent is started into.
      if (verb === 'tab create') {
        return ok({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } });
      }
      if (verb === 'agent start') {
        return ok({ agent: { name: 's1', pane_id: 'w1:p2', agent_status: 'idle' } });
      }
      if (verb === 'agent get') return alive ? ok({ agent: { pane_id: 'w1:p2' } }) : agentGone;
      // The pane is still there; it is the agent that is gone.
      if (verb === 'pane get') return ok({});
      return ok({});
    };
  }

  it('startAgent refuses rather than handing back an empty pane', () => {
    const term = new Terminal({ run: pretendingHerdr(false) });
    expect(() =>
      term.startAgent({ container: 'w1', name: 's1', kind: 'codex', cwd: '.' }),
    ).toThrow(/no agent is there/);
  });

  it('startAgent returns normally when the agent really is there', () => {
    const term = new Terminal({ run: pretendingHerdr(true) });
    const started = term.startAgent({ container: 'w1', name: 's1', kind: 'claude', cwd: '.' });
    expect(started.pane).toBe('w1:p2');
    expect(started.name).toBe('s1');
  });

  /**
   * A new tab's shell is not at its prompt at once, and herdr refuses an
   * agent start into it with `agent_pane_busy` until it is. `refusals` is how many
   * times it says so; `code` what it says.
   */
  function slowShellHerdr(refusals: number, code = 'agent_pane_busy') {
    const calls: string[] = [];
    let asked = 0;
    const run = (args: readonly string[]) => {
      const verb = `${args[0]} ${args[1]}`;
      calls.push(`${verb} ${args[2] ?? ''}`.trim());
      if (verb === 'tab create') return ok({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } });
      if (verb === 'agent start') {
        asked += 1;
        if (asked <= refusals) return { code: 1, stdout: '', stderr: `{"error":{"code":"${code}","message":"x"}}` };
        return ok({ agent: { name: 's1', pane_id: 'w1:p2', agent_status: 'idle' } });
      }
      if (verb === 'agent get') return ok({ agent: { pane_id: 'w1:p2' } });
      return ok({});
    };
    return { run, calls };
  }

  it('asks a busy new pane again until its shell is ready', () => {
    const herdr = slowShellHerdr(3);
    const slept: number[] = [];
    const term = new Terminal({ run: herdr.run, settleMs: 0, sleep: (ms) => slept.push(ms) });
    const started = term.startAgent({ container: 'w1', name: 's1', kind: 'claude', cwd: '.' });
    expect(started.pane).toBe('w1:p2');
    expect(herdr.calls.filter((c) => c.startsWith('agent start'))).toHaveLength(4);
    expect(slept).toEqual([500, 500, 500]);
    expect(herdr.calls, 'a pane that took its agent stays').not.toContain('pane close w1:p2');
  });

  it('gives up once the budget is spent, and closes the tab it made', () => {
    const herdr = slowShellHerdr(1000);
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const term = new Terminal({ run: herdr.run, settleMs: 0, busyRetryMs: 15000, sleep: (ms) => { clock += ms; } });
      let caught: unknown;
      try {
        term.startAgent({ container: 'w1', name: 's1', kind: 'claude', cwd: '.' });
      } catch (err) {
        caught = err;
      }
      expect((caught as TerminalError).code).toBe(TerminalError.codes.busy);
      expect((caught as TerminalError).message).toContain('within 15s');
      // Once at the start, then every 500ms up to and including the fifteenth second.
      expect(herdr.calls.filter((c) => c.startsWith('agent start'))).toHaveLength(31);
      expect(herdr.calls.at(-1)).toBe('pane close w1:p2');
    } finally {
      Date.now = realNow;
    }
  });

  it('does not wait out a refusal that is not about timing, and still closes the tab', () => {
    const herdr = slowShellHerdr(1, 'unsupported_kind');
    const slept: number[] = [];
    const term = new Terminal({ run: herdr.run, settleMs: 0, sleep: (ms) => slept.push(ms) });
    expect(() => term.startAgent({ container: 'w1', name: 's1', kind: 'claude', cwd: '.' })).toThrow(/unsupported_kind/);
    expect(slept).toEqual([]);
    expect(herdr.calls).toEqual(['tab create --workspace', 'agent start s1', 'pane close w1:p2']);
  });

  it('hands the work order over once the agent is at its input line', () => {
    // Herdr's `agent start` returns only when the agent is ready for input, so
    // the prompt cannot ride in argv: a shift that had it there was still
    // working at the deadline and came back as a timeout. It is typed in
    // afterwards, and the status handed back is the one taken after that.
    const sent: string[][] = [];
    let prompted = false;

    const run = (args: readonly string[]) => {
      sent.push([...args]);
      const verb = `${args[0]} ${args[1]}`;
      if (verb === 'tab create') {
        return ok({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } });
      }
      if (verb === 'agent start') {
        return ok({ agent: { name: 's1', pane_id: 'w1:p2', agent_status: 'idle' } });
      }
      if (verb === 'agent prompt') {
        prompted = true;
        return ok({});
      }
      if (verb === 'agent get') {
        return ok({ agent: { pane_id: 'w1:p2', agent_status: prompted ? 'working' : 'idle' } });
      }
      return ok({});
    };

    const started = new Terminal({ run }).startAgent({
      container: 'w1',
      name: 's1',
      kind: 'claude',
      cwd: '.',
      argv: ['--dangerously-skip-permissions'],
      prompt: 'read the brief',
    });

    const prompt = sent.find((a) => a[1] === 'prompt');
    expect(prompt, 'the work order is typed in after the start').toEqual(['agent', 'prompt', 'w1:p2', 'read the brief']);
    expect(sent.some((a) => a[1] === 'send-keys'), 'nothing was answered blind').toBe(false);
    expect(started.status, 'the status is the one after the hand-over').toBe('working');
  });

  it('answers the trust dialog, then hands the work order over', () => {
    // Herdr can call an agent ready while the harness is still holding up
    // "is this a project you trust?". The harness restarts behind that dialog
    // and comes up at an empty input line, so the prompt is typed in only
    // once it is there — a shift that looks alive and was asked nothing is
    // the failure this guards.
    const trustScreen = ' ❯ 1. Yes, I trust this folder\n   2. No, exit';
    const sent: string[][] = [];
    let cleared = false;

    const run = (args: readonly string[]) => {
      sent.push([...args]);
      const verb = `${args[0]} ${args[1]}`;
      if (verb === 'tab create') {
        return ok({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } });
      }
      if (verb === 'agent start') {
        return ok({ agent: { name: 's1', pane_id: 'w1:p2', agent_status: 'idle' } });
      }
      if (verb === 'agent send-keys') {
        cleared = true;
        return ok({});
      }
      if (verb === 'agent read') {
        return { code: 0, stdout: cleared ? 'a normal prompt' : trustScreen, stderr: '' };
      }
      if (verb === 'agent get') {
        return ok({ agent: { pane_id: 'w1:p2', agent_status: cleared ? 'working' : 'blocked' } });
      }
      return ok({});
    };

    const started = new Terminal({ run }).startAgent({
      container: 'w1',
      name: 's1',
      kind: 'claude',
      cwd: '.',
      argv: ['--dangerously-skip-permissions'],
      prompt: 'read the brief',
    });

    const keys = sent.find((a) => a[1] === 'send-keys');
    expect(keys, 'the dialog is answered rather than left for nobody').toEqual([
      'agent', 'send-keys', 'w1:p2', 'enter',
    ]);
    const prompt = sent.find((a) => a[1] === 'prompt');
    expect(prompt?.[3], 'and the work order is handed over after it').toBe('read the brief');
    expect(started.status, 'the status is the settled one, not the three-second one').toBe('working');
  });

  it('leaves a question it does not recognise standing, and says so', () => {
    // The agent is running in a leased tree, so tearing the dispatch down
    // would destroy live work: the honest answer is `blocked`, which is what
    // supervision wakes on.
    const run = (args: readonly string[]) => {
      const verb = `${args[0]} ${args[1]}`;
      if (verb === 'tab create') {
        return ok({ tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } });
      }
      if (verb === 'agent start') {
        return ok({ agent: { name: 's1', pane_id: 'w1:p2', agent_status: 'idle' } });
      }
      if (verb === 'agent read') {
        return { code: 0, stdout: 'Delete every branch? (y/N)', stderr: '' };
      }
      if (verb === 'agent get') return ok({ agent: { pane_id: 'w1:p2', agent_status: 'blocked' } });
      if (verb === 'agent send-keys') throw new Error('nothing unrecognised may be answered blind');
      return ok({});
    };

    const started = new Terminal({ run }).startAgent({
      container: 'w1', name: 's1', kind: 'claude', cwd: '.',
    });
    expect(started.status).toBe('blocked');
  });

  it('send refuses, because the text would be typed into the shell', () => {
    const term = new Terminal({ run: pretendingHerdr(false) });
    expect(() => term.send('w1:p2', 'here is your brief')).toThrow(/refusing to send/);
  });

  it('send goes through when the agent is alive', () => {
    const sent: string[][] = [];
    const run = (args: readonly string[]) => {
      sent.push([...args]);
      return pretendingHerdr(true)(args);
    };
    new Terminal({ run }).send('w1:p2', 'here is your brief');
    expect(sent.some((a) => a[0] === 'agent' && a[1] === 'prompt')).toBe(true);
  });
});
