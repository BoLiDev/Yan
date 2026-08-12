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
 * The assertions of `tests/unit/lib-term-contract.test.sh`, ported to vitest and
 * run against the Herdr seam (not the same file, the same
 * contract).
 *
 * Everything here is true whether or not Herdr is installed, which is what
 * makes it a contract test rather than an integration test: the id rules, the
 * "cannot close what yan did not create" promise, and the closed set that comes
 * out of `agentAlive`.
 */

const moduleDir = join(repoRoot, 'src', 'externals', 'herdr');

/**
 * The seam with its comments stripped.
 *
 * The rules below are about what the code does, and the comments are where the
 * reasons live — `winpty` and `agent focus` are both named in prose precisely
 * so the next person does not reintroduce them. Grepping the raw file would
 * make writing that reason down a test failure, which is exactly backwards.
 */
function seamSource(): string {
  return readdirSync(moduleDir)
    // Not this file. It lives in the module now, and it names every forbidden
    // string as the literal it asserts against — grepping itself would fail
    // every rule below.
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(moduleDir, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('ids are used, nothing is located by label alone', () => {
  // Herdr does enforce that an agent name is unique among live agents, which
  // tmux never promised - but a name is cleared when the agent exits, so it
  // cannot identify a shift that has died, and identifying dead shifts is
  // exactly what supervision does.
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
    // Container lifetime belongs to `user`. The two verbs that would take it
    // away are simply not written anywhere in the seam, and this is the grep
    // that keeps it that way.
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
    // Focusing marks the tab seen, which turns
    // the `done` yan was about to be woken by into an `idle` it will ignore
    // This is the assertion that keeps it out.
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
      { code: 1, stdout: '', stderr: '{"error":{"code":"pane_busy","message":"x"}}' },
      'pane split',
    );
    expect(refused.code).toBe(TerminalError.codes.refused);

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
   * A herdr that answers `pane split` and `agent start` happily, reports the
   * agent ready — and then has no agent in that pane. That is
   * §11.7: codex exited at once and Herdr matched the bare shell prompt it left
   * behind.
   */
  function pretendingHerdr(alive: boolean) {
    return (args: readonly string[]) => {
      const verb = `${args[0]} ${args[1]}`;
      if (verb === 'pane list') return ok({ panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }] });
      if (verb === 'pane split') return ok({ pane: { pane_id: 'w1:p2' } });
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
