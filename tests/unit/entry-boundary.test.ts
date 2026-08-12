import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot, runYan } from '../helpers/fixtures.js';

/**
 * The entry point's two structural rules, which no unit test of a command can
 * reach (cli-ux.md §2, §4; architecture.md §2).
 *
 *   PROMPTS ARE FOR PEOPLE. Agents already know their arguments, so the
 *   commands only they run must never grow one — a prompt reached by a hook, a
 *   script or an agent is a hang, and a hang inside a hook is invisible.
 *
 *   `attach` IS NOT IN THE VOCABULARY. V2's yan joins the multiplexer `user` is
 *   already in, so there is nothing to attach to. The word surviving in a
 *   command, a record field or the model's instructions is how the concept
 *   comes back.
 *
 * This file replaces `tests/unit/soft-path-boundary.test.sh`, which asserted
 * the same rules about a soft path that lived in `ui/` and was launched from
 * `bin/lib-ui.sh`. Both are gone: Clack is an ordinary dependency now. What is
 * kept is every assertion that was about the RULE rather than about the shell.
 */

function read(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

function sourcesUnder(dir: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (entry.endsWith('.ts')) out.push({ path: full, source: readFileSync(full, 'utf8') });
  }
  return out;
}

describe('the model is never sent into the prompts', () => {
  const agents = read('AGENTS.md');

  it('AGENTS.md mentions no prompt toolkit, no package manager and no module', () => {
    for (const word of ['clack', 'Clack', 'npm ', '.mjs', 'soft-path', 'import ']) {
      expect(agents, 'AGENTS.md must not send the model into the human prompts').not.toContain(word);
    }
  });

  it('and still says the two things it has to', () => {
    // THE RULE THESE GUARD CHANGED SHAPE, AND THE GUARANTEE DID NOT.
    //
    // AGENTS.md used to say "you only ever run `yan <command>`", which stopped
    // the model reaching for the human prompts and, in the same sentence,
    // stopped it grepping a file. The second half made yan stupid, so the rule
    // is soft now — `yan` is the toolkit, judgement is the agent's — and what
    // has to survive is the part that was never about capability:
    //
    //   the prompts are for people. An agent knows its arguments and passes
    //   them; a prompt reached by an agent is a hang with nobody to answer it;
    //
    //   where a subcommand exists it is the right way to do that thing,
    //   because it knows what a raw git call does not.
    expect(agents, 'the prompts are for people, and the model passes flags').toContain(
      'prompts are for people at a keyboard, not',
    );
    expect(agents, 'and it says why re-implementing a subcommand goes wrong').toContain(
      'a raw `git` call does not',
    );
  });

  it('and does not let "you may run things" read as "you may decide things"', () => {
    // The loosening is about capability. Authority is a different question and
    // the same document has to say so, or the table below it quietly becomes
    // advisory.
    expect(agents).toContain('Being able to run a command is not');
    expect(agents, 'and that a shift is still how work is offloaded').toContain('A shift is still how work gets offloaded');
  });

  it('and still carries the authority rules and the Codex checkpoint', () => {
    expect(agents).toContain('yan unit set');
    expect(agents).toContain('yan land');
    expect(agents).toContain('mentioning anyone');
    expect(agents).toContain('yan wait --seconds');
  });
});

describe('agent-only commands grew no prompts', () => {
  // cli-ux.md §4: atomic commands used only by agents stay flag-only.
  for (const name of ['report', 'wait', 'drain', 'send']) {
    it(`yan ${name} neither resolves nor imports the prompts`, () => {
      const source = read('src', 'cli', `${name}.ts`);
      expect(source).not.toContain('../ui/');
      expect(source).not.toContain("shared/resolve.js");
      expect(source).not.toContain('isTty');
    });
  }
});

describe('`attach` is out of the vocabulary', () => {
  it('appears nowhere under src/', () => {
    const offenders = sourcesUnder(join(repoRoot, 'src'))
      .filter((f) => f.source.includes('attach'))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('appears in neither of the two always-loaded instruction files', () => {
    expect(read('AGENTS.md')).not.toContain('attach');
    expect(read('CLAUDE.md')).not.toContain('attach');
  });
});

describe('Clack is an ordinary dependency', () => {
  it('is pinned to an exact version in the one package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    const pin = pkg.dependencies?.['@clack/prompts'];
    expect(pin, '@clack/prompts has to be a dependency of yan itself').toBeDefined();
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is imported like any other package, with no discovery around it', () => {
    // The MVP looked for node in three places and launched a separate Node
    // island. Node is the runtime now, so the dance has nowhere left to live:
    // bin/ is where it was, and this is an import.
    const shell = readdirSync(join(repoRoot, 'bin'))
      .map((name) => readFileSync(join(repoRoot, 'bin', name), 'utf8'))
      .join('\n');
    for (const relic of ['YAN_NODE', 'NVM_DIR', 'ui_node', 'lib-ui']) {
      expect(shell, 'node is the runtime now, not an optional extra').not.toContain(relic);
    }
    expect(read('src', 'ui', 'prompts.ts')).toContain("from '@clack/prompts'");
  });

  /**
   * The three callers reach `src/ui/` through `await import(...)`, so a wrong
   * path there compiles, passes every test, and fails only in front of a person
   * at a keyboard — which is the one place nothing is watching. Loading the
   * compiled module is the cheap half of that risk; drawing a prompt needs a
   * real terminal and stays untested.
   */
  it('the prompts really resolve at run time, which only a dynamic import can get wrong', async () => {
    const prompts = (await import('../../dist/ui/prompts.js' as string)) as Record<string, unknown>;
    for (const name of ['askFor', 'chooseEntry', 'chooseTask', 'askTaskNew', 'CREATE_NEW']) {
      expect(prompts[name], name).toBeDefined();
    }
    for (const source of ['yan.ts', 'continue.ts', 'task.ts']) {
      expect(read('src', 'cli', source), source).toContain("await import('../ui/prompts.js')");
    }
  });
});

describe('bin/ holds three prefixes and no others', () => {
  it('a subcommand, a library, or a hook — plus the one node shim', () => {
    // `yan.mjs` is the npm `bin` target, not a fourth prefix: it is the same
    // entry point for callers who arrive through PATH rather than through the
    // absolute `$YAN_HOME/bin/yan` everything else hardcodes.
    for (const name of readdirSync(join(repoRoot, 'bin'))) {
      expect(/^(yan|yan\.mjs|yan-.*\.sh|lib-.*\.sh|hook-.*\.sh)$/.test(name), `bin/${name}`).toBe(
        true,
      );
    }
  });
});

describe('one exit code for "you called this wrongly"', () => {
  // The Phase 8 decision: Commander's own argument errors join yan's, at 2.
  // A caller reading `1` learns only that something went wrong; `2` says the
  // command line was wrong before anything happened.
  let home = '';

  beforeAll(() => {
    home = mkYanHome(join(mkTempDir(), 'home'), { withDist: true });
  });
  afterAll(cleanupTempDirs);

  it('agrees between an unknown option and a missing one', async () => {
    expect((await runYan(home, ['tree', 'get', '--nonsense'])).code).toBe(2);
    expect((await runYan(home, ['tree', 'get'])).code).toBe(2);
  });

  it('covers an unknown command, a missing option-argument and an unknown subcommand', async () => {
    expect((await runYan(home, ['bogus'])).code).toBe(2);
    expect((await runYan(home, ['unit', 'bogus'])).code).toBe(2);
    expect((await runYan(home, ['ls', '--json', '--nope'])).code).toBe(2);
  });

  it('and --help and --version are still not mistakes', async () => {
    expect((await runYan(home, ['--help'])).code).toBe(0);
    expect((await runYan(home, ['--version'])).code).toBe(0);
    expect((await runYan(home, ['ls', '--help'])).code).toBe(0);
  });
});

/**
 * Every list a person picks from is searchable.
 *
 * Testable only as source text: drawing a prompt needs a real terminal, and
 * what is worth guarding is not the drawing but the CHOICE — that nobody adds
 * a sixth list later with a plain `select` because it happened to be the
 * import already in the file. The lists grow (a monorepo's packages, a vault's
 * repositories and tasks) and an unfilterable list of forty is miserable in a
 * way that is nobody's fault by the time it happens.
 */
describe('the soft path filters', () => {
  it('imports no plain select or multiselect from clack', () => {
    const source = readFileSync(join(repoRoot, 'src', 'ui', 'prompts.ts'), 'utf8');
    const imports = /^import \{([^}]*)\} from '@clack\/prompts';/m.exec(source)?.[1] ?? '';
    const named = imports.split(',').map((n) => n.trim());

    expect(named, 'a searchable single-choice list').toContain('autocomplete');
    expect(named, 'a searchable multiple-choice list').toContain('autocompleteMultiselect');
    expect(named, 'the unfilterable one').not.toContain('select');
    expect(named, 'and its multiple-choice twin').not.toContain('multiselect');
  });

  it('gives every one of them a placeholder, so it looks like what it is', () => {
    const source = readFileSync(join(repoRoot, 'src', 'ui', 'prompts.ts'), 'utf8');
    const lists = source.match(/await autocomplete(?:Multiselect)?\(\{[\s\S]*?\n {2,6}\}\)/g) ?? [];
    expect(lists.length, 'the entry, done, continue, repo add, task new repos and its scopes').toBe(6);
    for (const list of lists) {
      expect(list, 'a search box nobody knows is a search box is a select').toContain('placeholder');
    }
  });
});
