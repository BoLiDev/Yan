import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../../tests/helpers/fixtures.js';
import { liftEvidence, parseBrief, resolveYear } from './brief.js';

const brief = (...deliverables: string[]): string =>
  ['# t1 title', '', '## Description', '', 'What it is for.', '', '## Deliverables', '', ...deliverables, ''].join('\n');

describe("t128's own brief.md, as it was on 09-19", () => {
  const text = readFileSync(join(repoRoot, 'tests', 'fixtures', 'briefs', 't128.md'), 'utf8');
  const { shape, deliverables } = parseBrief(text, '2026-09-19');

  it('is in the shape, every item in file order', () => {
    expect(shape).toBe('sections');
    expect(deliverables.map((d) => d.mark)).toEqual([
      ...Array<string>(12).fill('done'), 'todo', 'todo', 'dropped', 'dropped', 'dropped', 'dropped',
    ]);
  });

  it('dates every delivered item and lifts the evidence off the ones that carry it', () => {
    const done = deliverables.filter((d) => d.mark === 'done');
    expect(done.every((d) => d.date === '2026-09-18')).toBe(true);
    expect(done.map((d) => d.evidence)).toEqual([
      'PR #54', 'PR #53', 'PR #53', 'PR #53', 'PR #53', 'PR #54', 'PR #52', null, null, 'PR #51', 'PR #50', null,
    ]);
    expect(done[0]?.text).toMatch(/^`yan ls` is an overview of what is being worked on: a card per open task/);
  });

  it('unwraps an item into one line and keeps its backticks, dashes and URLs as typed', () => {
    const design = deliverables[11]?.text ?? '';
    expect(design).not.toContain('\n');
    expect(design).toContain('presets `7d · 30d · 90d · 2026 · All`');
    expect(design).toContain('https://claude.ai/artifact/D9LkwBRW8dhB9tyhSj71EZ');
    expect(deliverables[14]?.text).toMatch(/^Rewriting brief Descriptions .* — `user` on 09-18:/);
  });

  it('dates nothing that is not delivered', () => {
    expect(deliverables.filter((d) => d.mark !== 'done').every((d) => d.date === null)).toBe(true);
  });
});

describe('a brief that is not in the shape', () => {
  it('is missing when there is no file', () => {
    expect(parseBrief(undefined, '2026-09-19')).toEqual({ shape: 'missing', deliverables: [] });
  });

  it('is free-form without a Description or a Deliverables heading', () => {
    const text = '# t1 title\n\nNotes as they came:\n- [x] 09-01 · looks like an item\n- tried pg_dump\n';
    expect(parseBrief(text, '2026-09-19')).toEqual({ shape: 'free-form', deliverables: [] });
  });

  it('is free-form when one top-level bullet carries no mark: it is not guessed at', () => {
    expect(parseBrief(brief('- [x] 09-06 · The outline.', '- the rest, still open'), '2026-09-19'))
      .toEqual({ shape: 'free-form', deliverables: [] });
    expect(parseBrief(brief('- [ ] one', '* two'), '2026-09-19').shape).toBe('free-form');
  });

  it('has no deliverables when the list is empty or the heading is missing', () => {
    expect(parseBrief(brief(), '2026-09-19')).toEqual({ shape: 'sections', deliverables: [] });
    expect(parseBrief('# t1\n\n## Description\n\nWhat.\n', '2026-09-19')).toEqual({ shape: 'sections', deliverables: [] });
  });
});

describe('an item', () => {
  it('reads the three marks, an upper-case X included', () => {
    const { deliverables } = parseBrief(brief('- [ ] a', '- [x] b', '- [X] c', '- [-] d'), '2026-09-19');
    expect(deliverables.map((d) => d.mark)).toEqual(['todo', 'done', 'done', 'dropped']);
  });

  it('runs to the next heading of level one or two, not three', () => {
    const text = brief('- [ ] a', '### a note', '- [ ] b') + '\n## Later\n\n- [ ] not an item\n';
    expect(parseBrief(text, '2026-09-19').deliverables.map((d) => d.text)).toEqual(['a', 'b']);
  });

  it('keeps a nested bullet on its own line', () => {
    const { deliverables } = parseBrief(brief('- [ ] the parent, wrapped', '  onto a second line', '  - a child', '  - another'), '2026-09-19');
    expect(deliverables[0]?.text).toBe('the parent, wrapped onto a second line\n- a child\n- another');
  });

  it('leaves out a paragraph between items: it belongs to none of them', () => {
    const { deliverables } = parseBrief(brief('- [ ] a', '', 'A loose paragraph.', '  still loose', '- [ ] b'), '2026-09-19');
    expect(deliverables.map((d) => d.text)).toEqual(['a', 'b']);
  });

  it('joins wide characters across a wrap with nothing', () => {
    const { deliverables } = parseBrief(brief('- [ ] 呼吸引导的', '  声音'), '2026-09-19');
    expect(deliverables[0]?.text).toBe('呼吸引导的声音');
  });
});

describe('the date of a delivered item', () => {
  it('takes MM-DD or YYYY-MM-DD off the front, with the separator after it', () => {
    const { deliverables } = parseBrief(brief('- [x] 09-10 · one', '- [x] 2025-03-05 · two', '- [x] 09-11 three', '- [x] 09-12'), '2026-09-19');
    expect(deliverables.map((d) => [d.date, d.text])).toEqual([
      ['2026-09-10', 'one'], ['2025-03-05', 'two'], ['2026-09-11', 'three'], ['2026-09-12', ''],
    ]);
  });

  it('gets its year from notAfter: a January task with a 12-30 item', () => {
    const { deliverables } = parseBrief(brief('- [x] 12-30 · the last invoices', '- [x] 01-05 · the accounts closed'), '2026-01-08');
    expect(deliverables.map((d) => d.date)).toEqual(['2025-12-30', '2026-01-05']);
  });

  it('is never after notAfter: a task closed in March does not move a year once March has passed', () => {
    expect(resolveYear('03-05', '2025-03-10')).toBe('2025-03-05');
    expect(resolveYear('03-11', '2025-03-10')).toBe('2024-03-11');
    expect(resolveYear('03-10', '2025-03-10')).toBe('2025-03-10');
  });

  it('is null on a delivered item that has none, which is kept', () => {
    const { deliverables } = parseBrief(brief('- [x] The box finds pages.'), '2026-09-19');
    expect(deliverables).toEqual([{ mark: 'done', date: null, evidence: null, text: 'The box finds pages.' }]);
  });

  it('is not read off an item that is not delivered', () => {
    const { deliverables } = parseBrief(brief('- [ ] 09-10 · planned', '- [-] 09-11 · dropped'), '2026-09-19');
    expect(deliverables.map((d) => [d.date, d.text])).toEqual([[null, '09-10 · planned'], [null, '09-11 · dropped']]);
  });

  it('is not a day that does not exist', () => {
    const { deliverables } = parseBrief(brief('- [x] 13-40 · not a date', '- [x] 02-30 · nor this'), '2026-09-19');
    expect(deliverables.map((d) => d.date)).toEqual([null, null]);
    expect(deliverables[0]?.text).toBe('13-40 · not a date');
  });
});

describe('the evidence', () => {
  it('is a leading PR or MR reference followed at once by the separator', () => {
    expect(liftEvidence('PR #54 · the overview')).toEqual({ evidence: 'PR #54', text: 'the overview' });
    expect(liftEvidence('MR !87 · a test')).toEqual({ evidence: 'MR !87', text: 'a test' });
  });

  it('stays in the text when words come between', () => {
    const text = 'PR #53 for the data; the print still to prove it · the rest';
    expect(liftEvidence(text)).toEqual({ evidence: null, text });
  });

  it('is lifted after the date', () => {
    const { deliverables } = parseBrief(brief('- [x] 09-18 · PR #55 · shipped'), '2026-09-19');
    expect(deliverables[0]).toEqual({ mark: 'done', date: '2026-09-18', evidence: 'PR #55', text: 'shipped' });
  });
});
