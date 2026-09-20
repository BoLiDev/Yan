import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_TYPES } from '../../src/records/log/index.js';

/**
 * Every main agent is told how to remember and how to dispatch, whichever
 * harness it runs under.
 * The three instruction files are written separately, so what they must all
 * carry is pinned here rather than trusted to stay in step.
 */

const FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

function read(name: string): string {
  return readFileSync(join(process.cwd(), name), 'utf8');
}

describe.each(FILES)('%s', (name) => {
  const text = read(name);

  it('names every log type the code accepts, and how to write one', () => {
    for (const type of LOG_TYPES) expect(text, type).toContain(`\`${type}\``);
    expect(text).toContain('yan log');
    expect(text).toContain('--note');
  });

  it('points at every memory file', () => {
    for (const file of ['brief.md', 'deliverable.json', 'log.md', 'task.json', 'artifacts/', 'mem/learnings/', 'mem/user.md', 'outcome.md']) {
      expect(text, file).toContain(file);
    }
  });

  it('names the one command that writes the deliverables, and how a status moves', () => {
    // `deliverable.json` above has a writer or it has none; these are the
    // three subcommands that move a deliverable, spelled as the file spells
    // them, so a dropped argument is a failure rather than a surprise later.
    expect(text, 'the record has one writer').toContain('yan deliverable');
    for (const call of ['done <id>', 'abandon <id> --reason', 'todo <id>']) {
      expect(text, call).toContain(call);
    }
  });

  it('keeps task.json in step with what user says', () => {
    for (const flag of ['--branch', '--target', '--scope', '--needs']) expect(text, flag).toContain(flag);
    expect(text).toContain('yan unit add');
  });

  it('says a shift lasts until its work is accepted, and uix is accepted by user', () => {
    expect(text).toContain('--user-accepted');
    expect(text).toContain('1000');
    expect(text).toContain('yan send');
  });

  it('says how to give work up, and to abandon a shift dispatched as the wrong kind', () => {
    expect(text).toContain('yan shift abandon');
    expect(text).toContain('yan abandon');
    expect(text).toContain('--reason');
  });

  it('names the three scenarios and how a dispatch chooses one', () => {
    for (const scenario of ['explore', 'coding', 'uix']) expect(text, scenario).toContain(`\`${scenario}\``);
    expect(text).toContain('--scenario');
    expect(text).toContain('--tier');
  });
});
