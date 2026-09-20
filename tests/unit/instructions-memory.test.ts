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

/**
 * `user`'s example of a deliverable, in each file's own language. The
 * definition is the one thing an agent writes its first deliverables from,
 * and the example is what says how one sounds.
 */
const EXAMPLE: Record<string, string> = {
  'CLAUDE.md': 'the UI shows the title, and the title is green',
  'AGENTS.md': 'the UI shows the title, and the title is green',
  'GEMINI.md': '\u754c\u9762\u4e0a\u663e\u793a\u6807\u9898\uff0c\u5e76\u4e14\u6807\u9898\u662f\u7eff\u8272\u7684',
};

/**
 * The grain, in each file's own language: a deliverable is one thing a user
 * can do or see, not one test assertion. The main agent wrote twenty for one
 * task off the older wording, so a file that drops this drifts straight back.
 */
const GRAIN: Record<string, string[]> = {
  'CLAUDE.md': ['user story', 'test assertion'],
  'AGENTS.md': ['user story', 'test assertion'],
  'GEMINI.md': ['\u7528\u6237\u6545\u4e8b', '\u6d4b\u8bd5\u65ad\u8a00'],
};

/**
 * That the list is the task's goal and stays aligned with `user`: what the
 * work is measured against, changed in the turn `user` moves it, and shown to
 * them afterwards. `user` reads it with `yan show` to catch drift early, so a
 * file that says only what a deliverable is leaves out what the list is for.
 */
const ALIGNED: Record<string, string[]> = {
  'CLAUDE.md': ['yan show', 'once they agree'],
  'AGENTS.md': ['yan show', 'once they agree'],
  'GEMINI.md': ['yan show', '\u6c38\u8fdc\u4e0d\u81ea\u4f5c\u4e3b\u5f20'],
};

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

  it("carries user's example of a deliverable, so the definition keeps its voice", () => {
    expect(text).toContain(EXAMPLE[name]);
  });

  it('says a deliverable is a user story rather than a test assertion', () => {
    for (const said of GRAIN[name] as string[]) expect(text, said).toContain(said);
  });

  it('says the list is the goal, changed with user and shown to them after', () => {
    for (const said of ALIGNED[name] as string[]) expect(text, said).toContain(said);
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
