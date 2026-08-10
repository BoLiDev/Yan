import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as term from '../../src/seams/terminal/index.js';
import { herdrErrorCode, mapError } from '../../src/seams/terminal/client.js';
import { AGENT_STATUS, HERDR_PROTOCOL } from '../../src/seams/terminal/types.js';
import { YanError } from '../../src/util/error.js';
import { repoRoot } from '../helpers/fixtures.js';

/**
 * The assertions of `tests/unit/lib-term-contract.test.sh`, ported to vitest and
 * run against the Herdr seam (terminal.md §8: not the same FILE, the same
 * CONTRACT — the bash original keeps running against tmux until Phase 9).
 *
 * Everything here is true whether or not Herdr is installed, which is what
 * makes it a contract test rather than an integration test: the id rules, the
 * "cannot close what yan did not create" promise, and the closed set that comes
 * out of `termAgentAlive`.
 */

const seamDir = join(repoRoot, 'src', 'seams', 'terminal');

/**
 * The seam with its comments stripped.
 *
 * The rules below are about what the CODE does, and the comments are where the
 * reasons live — `winpty` and `agent focus` are both named in prose precisely
 * so the next person does not reintroduce them. Grepping the raw file would
 * make writing that reason down a test failure, which is exactly backwards.
 */
function seamSource(): string {
  return readdirSync(seamDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(seamDir, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('ids are used, nothing is located by label alone', () => {
  // Herdr does enforce that an agent NAME is unique among LIVE agents, which
  // tmux never promised - but a name is cleared when the agent exits, so it
  // cannot identify a shift that has died, and identifying dead shifts is
  // exactly what supervision does.
  const notPaneIds = ['yan', 's3-auth', '', '@3', '%7', 'w1', 'w1:t1', '3', 'w1:p'];

  it.each(notPaneIds)('termSend refuses %j', (bad) => {
    let thrown: unknown;
    try {
      term.termSend(bad, 'hello');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(YanError);
    expect((thrown as YanError).exitCode).toBe(2);
    expect((thrown as YanError).message).toContain('never a label');
  });

  it.each(notPaneIds)('termRead / termAgentAlive / termAgentClose refuse %j', (bad) => {
    for (const call of [
      () => term.termRead(bad),
      () => term.termAgentAlive(bad),
      () => term.termAgentClose(bad),
    ]) {
      let thrown: unknown;
      try {
        call();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(YanError);
      expect((thrown as YanError).exitCode).toBe(2);
    }
  });

  it.each(['mysession', 't042', '', 'w1:p1', '$0', '%7'])(
    'termList refuses the container name %j',
    (bad) => {
      let thrown: unknown;
      try {
        term.termList(bad === '' ? 'not-a-workspace' : bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(YanError);
      expect((thrown as YanError).message).toContain('never a name');
    },
  );

  it('a well-formed pane id gets past the guard', () => {
    // It then fails on Herdr, not on parsing — so it must not be a usage error.
    let thrown: unknown;
    try {
      term.termRead('w9:p99');
    } catch (e) {
      thrown = e;
    }
    if (thrown !== undefined) {
      expect((thrown as YanError).exitCode).not.toBe(2);
    }
  });
});

describe('usage errors', () => {
  it('are exit 2, which means you called this wrongly', () => {
    expect(() => term.termContainerCreate('')).toThrow(YanError);
    expect(() => term.termRead('w1:p1', 0)).toThrow(/whole number of lines/);
    expect(() => term.termSend('w1:p1', '')).toThrow(/nothing to send/);
    expect(() =>
      term.termAgentStart({ container: 'w1', name: 'Bad Name', kind: 'claude', cwd: '.' }),
    ).toThrow(/agent name/);
    expect(() =>
      term.termAgentStart({ container: 'w1', name: 'ok', kind: '', cwd: '.' }),
    ).toThrow(/agent kind/);
    expect(() =>
      term.termAgentStart({ container: 'w1', name: 'ok', kind: 'claude', cwd: '' }),
    ).toThrow(/working directory/);
  });
});

describe('the seam cannot close what yan did not create', () => {
  const source = seamSource();

  it('never spells workspace close or tab close', () => {
    // Container lifetime belongs to `user`. The two verbs that would take it
    // away are simply not written anywhere in the seam, and this is the grep
    // that keeps it that way (conventions §5, regression 6).
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
    // conventions §5, regression 5. Focusing marks the tab SEEN, which turns
    // the `done` yan was about to be woken by into an `idle` it will ignore
    // (supervision.md §3). This is the assertion that keeps it out.
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
    // environment (terminal.md §3).
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
    expect(notFound.code).toBe(term.TERM_NOT_FOUND);

    const refused = mapError(
      { code: 1, stdout: '', stderr: '{"error":{"code":"pane_busy","message":"x"}}' },
      'pane split',
    );
    expect(refused.code).toBe(term.TERM_REFUSED);

    // rc 2 is a CLI syntax error - a bug in yan, never a runtime condition.
    expect(mapError({ code: 2, stdout: '', stderr: 'usage: …' }, 'pane split').code).toBe(
      term.TERM_BUG,
    );

    // rc 1 with no structured error is a transport problem, not a verdict.
    expect(mapError({ code: 1, stdout: '', stderr: 'boom' }, 'agent list').code).toBe(
      term.TERM_UNREACHABLE,
    );
    expect(mapError({ code: 127, stdout: '', stderr: 'no herdr' }, 'agent list').code).toBe(
      term.TERM_UNREACHABLE,
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
      expect(term.termAgentAlive('w9:p99')).toBe('unknown');
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
    const generated = readFileSync(join(seamDir, 'types.ts'), 'utf8');
    expect(generated.startsWith('// GENERATED')).toBe(true);
  });
});
