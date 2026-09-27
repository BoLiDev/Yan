import { describe, expect, it } from 'vitest';
import { deliverableAside, deliverableLines, deliverableTally, refLink } from './deliverables.js';
import type { Deliverable } from '../../records/task/index.js';

/**
 * The block `user` reads to review the plan. The claim is that a long
 * deliverable stays readable: it wraps to the terminal under the text column
 * rather than running off the right edge, and a line of Chinese wraps by the
 * columns it takes rather than by the characters it has.
 */

const todo = (id: string, text: string): Deliverable => ({ id, text, status: 'todo' });

/** Where the text column starts: two spaces, the id, two, the status word, two. */
const HANG = 2 + 2 + 2 + 'abandoned'.length + 2;

describe('the deliverables block', () => {
  it('lays a short one out in one line, the id and the status in their columns', () => {
    expect(deliverableLines([todo('d1', 'The header carries a search box.')], {}, 80)).toEqual([
      '  d1  todo       The header carries a search box.',
    ]);
  });

  it('wraps a long text to the terminal, hanging under the text column', () => {
    const text = 'The work report opens in the browser and shows everything user worked on over a date range, with totals by week and by project.';
    const lines = deliverableLines([todo('d1', text)], {}, 80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 79), lines.join('\n')).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith(' '.repeat(HANG))).toBe(true);
    expect(lines.map((l) => l.trim()).join(' ')).toBe(`d1  todo       ${text}`);
  });

  it('wraps the aside under the text the same way, and never breaks a word in two', () => {
    const done: Deliverable = {
      id: 'd1',
      text: 'Every 2025 invoice is with its customer.',
      status: 'done',
      doneAt: '2026-09-18',
      refs: ['PR #12', 'PR #13', 'PR #14', 'PR #15', 'PR #16', 'PR #17'],
    };
    const lines = deliverableLines([done], {}, 60);
    const aside = lines.slice(1).map((l) => l.slice(HANG));
    expect(aside.length).toBeGreaterThan(1);
    expect(aside.join(' ')).toBe('2026-09-18 · PR #12 · PR #13 · PR #14 · PR #15 · PR #16 · PR #17');
    expect(lines.every((l) => l.length <= 59)).toBe(true);
  });

  it('counts a wide character as two columns', () => {
    const text = '界面上显示标题，并且标题是绿色的。报告页在浏览器里打开，按周和按项目汇总。';
    const lines = deliverableLines([todo('d1', text)], {}, 80);
    expect(lines.length).toBeGreaterThan(1);
    const cells = (s: string): number => [...s].reduce((n, c) => n + (/[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿＀-｠]/.test(c) ? 2 : 1), 0);
    expect(lines.every((l) => cells(l) <= 79), lines.join('\n')).toBe(true);
    expect(lines.map((l) => l.trim()).join('')).toContain('并且标题是绿色的');
  });

  it('lays out at 80 for a pipe, and never narrower than the text column can hold', () => {
    const text = 'a '.repeat(80).trim();
    expect(deliverableLines([todo('d1', text)], {}, undefined)).toEqual(deliverableLines([todo('d1', text)], {}, 80));
    expect(deliverableLines([todo('d1', text)], {}, 20).every((l) => l.slice(HANG).length <= 20)).toBe(true);
  });

  it('tallies what there is of each, and nothing of what there is none', () => {
    expect(deliverableTally([])).toBe('');
    expect(deliverableTally([todo('d1', 'a'), todo('d2', 'b')])).toBe('2 to do');
  });
});

/**
 * What a ref points at is worked out from the ref itself, because `PR #58`
 * cannot say which repository it belongs to. Only these answers ever carry an
 * address, and everything else is text to be printed as it was typed.
 */
describe('a ref', () => {
  it('reads a GitHub pull request as PR #n', () => {
    expect(refLink('https://github.com/acme/site/pull/58')).toEqual({
      label: 'PR #58',
      href: 'https://github.com/acme/site/pull/58',
    });
    expect(refLink('https://www.github.com/acme/site/pull/58/files').label).toBe('PR #58');
    expect(refLink('https://github.com/acme/site/pull/58#discussion_r1').label).toBe('PR #58');
  });

  it('reads a GitLab merge request as MR !n, on any host, because GitLab is self-hosted', () => {
    expect(refLink('https://gitlab.acme.internal/team/app/-/merge_requests/87')).toEqual({
      label: 'MR !87',
      href: 'https://gitlab.acme.internal/team/app/-/merge_requests/87',
    });
    expect(refLink('https://gitlab.com/a/b/c/-/merge_requests/9/diffs').label).toBe('MR !9');
  });

  it('labels any other http(s) URL with its host', () => {
    expect(refLink('https://jira.acme.internal/browse/ACME-31')).toEqual({
      label: 'jira.acme.internal',
      href: 'https://jira.acme.internal/browse/ACME-31',
    });
    expect(refLink('http://localhost:8080/build/12').label).toBe('localhost:8080');
  });

  it('leaves a ref that is not a URL exactly as it was typed, and gives it no address', () => {
    for (const plain of ['PR #58', 'MR !87', 'the deploy on 09-18', 'PR #32 <!-- squashed -->']) {
      expect(refLink(plain)).toEqual({ label: plain, href: null });
    }
  });

  it('never gives an address to a scheme that is not http or https', () => {
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:msgbox']) {
      expect(refLink(hostile), hostile).toEqual({ label: hostile, href: null });
    }
  });

  it('prints a URL in its short form beside the day, and leaves the stored refs as they were', () => {
    const done: Deliverable = {
      id: 'd1',
      text: 'first',
      status: 'done',
      doneAt: '2026-09-18',
      refs: ['https://github.com/acme/site/pull/58', 'PR #12'],
    };
    expect(deliverableAside(done)).toBe('2026-09-18 \u00b7 PR #58 \u00b7 PR #12');
    expect(done.refs, 'printing never rewrites the refs').toEqual([
      'https://github.com/acme/site/pull/58',
      'PR #12',
    ]);
  });
});
