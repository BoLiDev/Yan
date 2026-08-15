import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot, runYan } from '../helpers/fixtures.js';

/**
 * The entry point's structural rules, which no unit test of a command can
 * reach: the commands only agents run never prompt, `attach` appears nowhere
 * in the vocabulary, and the two instruction files stay one document.
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
    // Two claims have to survive however the instructions are reworded: the
    // prompts are for people, and where a subcommand exists it is the right
    // way to do that thing.
    const said = agents.replace(/\s+/g, ' ');
    expect(said, 'the prompts are for people, and the model passes flags').toContain(
      'prompts are for people at a keyboard, not',
    );
    expect(said, 'and it says why re-implementing a subcommand goes wrong').toContain(
      'a raw `git` call does not',
    );
  });

  it('and does not let "you may run things" read as "you may decide things"', () => {
    // The test the authority table is derived from, not its rows, which move.
    // Whitespace is collapsed first, so a rewrapped sentence still matches.
    const said = agents.replace(/\s+/g, ' ');
    expect(said).toContain('needs `user` to say so first');
    expect(said, 'and it names what makes something need asking').toContain(
      'destroys work which exists nowhere else',
    );
  });

  it('and still carries the authority rules and the Codex checkpoint', () => {
    expect(agents).toContain('yan unit set');
    expect(agents).toContain('yan land');
    expect(agents).toContain('mentioning anyone');
    expect(agents).toContain('yan wait --seconds');
  });
});

describe('the two instruction files are one document', () => {
  // CLAUDE.md and AGENTS.md are compared byte for byte outside
  // "## Supervision", which is the one section the two harnesses differ in.
  function withoutSupervision(text: string): string {
    const start = text.indexOf('## Supervision');
    if (start < 0) throw new Error('the section has to be findable to be excluded');
    return text.slice(0, start);
  }

  it('agree everywhere except the section that is about the harness', () => {
    expect(withoutSupervision(read('CLAUDE.md'))).toBe(withoutSupervision(read('AGENTS.md')));
  });

  it('and each says how its own supervision is driven', () => {
    expect(read('CLAUDE.md'), 'Claude is armed by the Stop hook').toContain('The Stop hook arms');
    expect(read('AGENTS.md'), 'Codex runs the loop itself').toContain('yan wait --seconds');
  });
});

describe('agent-only commands grew no prompts', () => {
  // Atomic commands used only by agents stay flag-only.
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
    const shell = readdirSync(join(repoRoot, 'bin'))
      .map((name) => readFileSync(join(repoRoot, 'bin', name), 'utf8'))
      .join('\n');
    for (const relic of ['YAN_NODE', 'NVM_DIR', 'ui_node', 'lib-ui']) {
      expect(shell, 'node is the runtime now, not an optional extra').not.toContain(relic);
    }
    expect(read('src', 'ui', 'prompts.ts')).toContain("from '@clack/prompts'");
  });

  /**
   * `src/ui/` is reached through `await import(...)`, so a wrong path there
   * compiles and fails only in front of a person. Loading the compiled module
   * is what can be checked; drawing a prompt needs a real terminal.
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
    // `yan.mjs` is the npm `bin` target, not a fourth entry point.
    for (const name of readdirSync(join(repoRoot, 'bin'))) {
      expect(/^(yan|yan\.mjs|yan-.*\.sh|lib-.*\.sh|hook-.*\.sh)$/.test(name), `bin/${name}`).toBe(
        true,
      );
    }
  });
});

describe('one exit code for "you called this wrongly"', () => {
  // Commander's own argument errors join yan's, at 2.
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
 * Every list a person picks from is searchable. Checked as source text,
 * because drawing a prompt needs a real terminal.
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
