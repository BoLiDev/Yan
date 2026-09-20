import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_TYPES } from '../../src/records/log/index.js';

/**
 * Every main agent is told how to remember and how to dispatch, whichever
 * harness it runs under. The three files are one document in three copies, so
 * what they must all carry is pinned here rather than trusted to stay in step.
 */

const FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

/**
 * `user`'s example of a deliverable. The definition is the one thing an agent
 * writes its first deliverables from, and the example is what says how one
 * sounds.
 */
const EXAMPLE = 'the UI shows the title, and the title is green';

/**
 * The grain: a deliverable is one thing a user can do or see, not one test
 * assertion. The main agent wrote twenty for one task off the older wording,
 * so a file that drops this drifts straight back.
 */
const GRAIN = ['user story', 'test assertion'];

/**
 * That the list is the task's goal and stays aligned with `user`: what the
 * work is measured against, changed in the turn `user` moves it, and shown to
 * them afterwards. `user` reads it with `yan show` to catch drift early, so a
 * file that says only what a deliverable is leaves out what the list is for.
 */
const ALIGNED = ['yan show', 'once they agree'];

function read(name: string): string {
  return readFileSync(join(process.cwd(), name), 'utf8');
}

describe.each(FILES)('%s', (name) => {
  const text = read(name);
  const said = text.replace(/\s+/g, ' ');

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

  it('names the one command that writes the deliverables, and the bar each move takes', () => {
    // The subcommands are `yan --help`'s now. What the prompt still has to
    // carry is that the record has one writer, and what `done` and `abandon`
    // cost — the two moves an agent gets wrong by being generous with.
    expect(text, 'the record has one writer').toContain('yan deliverable');
    expect(said, 'done is seen to be true, never merged').toContain('`done` takes the bar');
    expect(said, 'and giving one up records why').toContain('`abandon` takes the reason');
  });

  it("carries user's example of a deliverable, so the definition keeps its voice", () => {
    expect(text).toContain(EXAMPLE);
  });

  it('says a deliverable is a user story rather than a test assertion', () => {
    for (const phrase of GRAIN) expect(text, phrase).toContain(phrase);
  });

  it('says the list is the goal, changed with user and shown to them after', () => {
    for (const phrase of ALIGNED) expect(text, phrase).toContain(phrase);
  });

  it('keeps task.json in step with what user says', () => {
    for (const flag of ['--branch', '--target', '--scope', '--needs']) expect(text, flag).toContain(flag);
    expect(text).toContain('yan unit add');
  });

  it('says a shift lasts until its work is accepted, and uix is accepted by user', () => {
    expect(text).toContain('--user-accepted');
    expect(text).toContain('yan send');
    // How long a line may be is `yan send --help`'s; what the prompt keeps is
    // what to do when what you have to say does not fit in one.
    expect(said, 'a longer answer goes in a file').toContain('naming a file for anything longer');
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
