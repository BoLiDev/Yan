import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../../tests/helpers/fixtures.js';
import type { Report } from './collect.js';
import { dataBlock, fillTemplate } from './page.js';

const template = readFileSync(join(repoRoot, 'templates', 'ui', 'report.html'), 'utf8');

const report: Report = {
  version: 2,
  generated_at: '2026-09-18T15:04:05Z',
  range: { since: '2026-08-01', until: null },
  tasks: [
    {
      id: 't002',
      title: 'invoice export <b>rounding</b>',
      project: 'ledger',
      state: 'done',
      description: 'A note such as </script><!-- x --> prints as typed.',
      started: '2026-08-03',
      completed: '2026-08-20',
      deliverables: [
        { mark: 'done', date: '2026-08-12', evidence: 'MR !87', text: 'a line such as `</script><!-- x -->` prints as typed' },
        { mark: 'done', date: '2026-08-20', evidence: 'PR #31', text: "replace `$&`, `$1`, `$'` and `$$` with the literal text" },
      ],
    },
  ],
};

/** The text of the one JSON block, as the page's own script reads it. */
function block(html: string): string {
  const m = /<script type="application\/json" id="yan-data">([\s\S]*?)<\/script>/.exec(html);
  if (m === null) throw new Error('no data block');
  return m[1] as string;
}

describe('the report page', () => {
  const html = fillTemplate(template, report);

  it('fills the placeholder and leaves out the mock line', () => {
    expect(template).toContain('/*YAN_DATA*/');
    expect(template).toContain('<!--YAN_MOCK-->');
    expect(html).not.toContain('/*YAN_DATA*/');
    expect(html).not.toContain('YAN_MOCK');
    expect(html).toContain('<script type="application/json" id="yan-data">{"version":2,');
  });

  it('keeps the rest of the template as it is', () => {
    const without = template.replace('/*YAN_DATA*/', '').replace('<!--YAN_MOCK-->\n', '');
    expect(html.replace(dataBlock(report), '')).toBe(without);
  });

  it('gives back the object it was given', () => {
    expect(JSON.parse(block(html))).toEqual(report);
  });

  it('does not let a </script> or <!-- in the data end the block', () => {
    expect(block(html)).not.toContain('<');
    expect(html.match(/<\/script>/g)).toHaveLength(template.match(/<\/script>/g)?.length ?? -1);
  });

  it('keeps replacement patterns as typed', () => {
    const texts = (JSON.parse(block(html)) as Report).tasks[0]?.deliverables.map((d) => d.text);
    expect(texts?.[1]).toBe("replace `$&`, `$1`, `$'` and `$$` with the literal text");
  });

  it('refuses a template without the placeholder', () => {
    expect(() => fillTemplate('<html></html>', report)).toThrow(/no \/\*YAN_DATA\*\//);
  });
});
