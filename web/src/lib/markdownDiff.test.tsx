import { describe, expect, it } from 'vitest';
import { renderMarkdownDiff } from './markdownDiff';

/** The diff of two texts as a document, to be looked into. */
function drawn(old: string | null, now: string): HTMLElement {
  const box = document.createElement('div');
  box.innerHTML = renderMarkdownDiff(old, now).html;
  return box;
}
const texts = (box: HTMLElement, selector: string): string[] => [...box.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '');

describe('a version of a Markdown text against the one before', () => {
  it('draws a changed paragraph once, the words taken out and put in marked in it, and leaves the rest alone', () => {
    const box = drawn('# Plan\n\nRetries are unbounded for now.\n\nNothing else.\n', '# Plan\n\nRetries are capped at five for now.\n\nNothing else.\n');
    expect(texts(box, '[data-diff]')).toEqual(['Retries are unboundedcapped at five for now.']);
    expect(texts(box, 'del')).toEqual(['unbounded']);
    expect(texts(box, 'ins')).toEqual(['capped at five']);
    expect(box.querySelector('h1')?.closest('[data-diff]')).toBeNull();
  });

  it('marks a block put in as added, and keeps one taken out where it was, marked as gone', () => {
    const box = drawn('# Plan\n\nFirst.\n\nDropped later.\n\nLast.\n', '# Plan\n\nFirst.\n\n## Risks\n\nLast.\n');
    expect(texts(box, '[data-diff=del]')).toEqual(['Dropped later.']);
    expect(texts(box, '[data-diff=add]')).toEqual(['Risks']);
    expect(texts(box, 'p, h2')).toEqual(['First.', 'Dropped later.', 'Risks', 'Last.']);
  });

  it('keeps a list a list, an item added, an item reworded and an item taken out each marked in its place', () => {
    const box = drawn('- one\n- two is slow\n- three\n', '- one\n- two is fast\n- four\n');
    expect(texts(box, 'li')).toEqual(['one', 'two is slowfast', 'three', 'four']);
    expect(texts(box, 'li del')).toEqual(['slow', 'three']);
    expect(texts(box, 'li ins')).toEqual(['fast', 'four']);
  });

  it('draws a table that changed once, still a table, the cells and the rows that changed marked in it', () => {
    const table = '| Name | Value |\n| --- | --- |\n| tries | 3 |\n| wait | 250 |\n| old | gone |\n';
    const box = drawn(table, table.replace('| 3 |', '| 5 |').replace('| 250 |', '| 250 ms |').replace('| old | gone |', '| new | here |'));
    expect(box.querySelectorAll('table')).toHaveLength(1);
    expect(texts(box, 'th')).toEqual(['Name', 'Value']);
    expect([...box.querySelectorAll('tbody tr')].map((tr) => texts(tr as HTMLElement, 'td'))).toEqual([['tries', '35'], ['wait', '250 ms'], ['old', 'gone'], ['new', 'here']]);
    expect(texts(box, 'td del')).toEqual(['3', 'old', 'gone']);
    expect(texts(box, 'td ins')).toEqual(['5', 'ms', 'new', 'here']);
  });

  it('takes a row for the row it was by its first cell, however much of the rest changed', () => {
    const table = '| Env | Note |\n| --- | --- |\n| live | unbounded for now |\n';
    const box = drawn(table, table.replace('unbounded for now', 'eight seconds at most'));
    expect([...box.querySelectorAll('tbody tr')].map((tr) => texts(tr as HTMLElement, 'td'))).toEqual([['live', 'unbounded for noweight seconds at most']]);
  });

  it('keeps a table inside a quote a table when a row of it changed', () => {
    const quote = '> | Name | Value |\n> | --- | --- |\n> | tries | 3 |\n';
    const box = drawn(quote, quote.replace('| 3 |', '| 5 |'));
    expect(texts(box, 'blockquote td')).toEqual(['tries', '35']);
  });

  it('shows a fence that changed, alone or inside a list, as the old one gone and the new one added, with no mark written into its code', () => {
    for (const lead of ['', '- step\n\n  ']) {
      const fence = (n: number): string => `${lead}\`\`\`js\n${lead ? '  ' : ''}const n = ${n};\n${lead ? '  ' : ''}\`\`\`\n`;
      const box = drawn(fence(1), fence(5));
      expect(texts(box, '[data-diff=del] pre')).toEqual(['const n = 1;']);
      expect(texts(box, '[data-diff=add] pre')).toEqual(['const n = 5;']);
      expect(box.querySelector('ins, del')).toBeNull();
    }
  });

  it('draws a table written in HTML as a table, blank lines inside it or not, a cell that changed marked in it and a row put in marked whole', () => {
    const table = (rows: string): string => `intro\n\n<table>\n  <tr>\n    <th>Name</th>\n    <th>Value</th>\n  </tr>\n\n${rows}</table>\n\nafter\n`;
    const row = (a: string, b: string): string => `  <tr>\n    <td>${a}</td>\n    <td>${b}</td>\n  </tr>\n`;
    const same = drawn(table(row('tries', '3')), table(row('tries', '3')));
    expect(texts(same, 'table td')).toEqual(['tries', '3']);
    expect(same.querySelector('[data-diff]')).toBeNull();

    const box = drawn(table(row('tries', '3 times')), table(row('tries', '5 times') + row('wait', '250')));
    expect(box.querySelectorAll('table')).toHaveLength(1);
    expect([...box.querySelectorAll('tr')].map((tr) => texts(tr as HTMLElement, 'th, td'))).toEqual([['Name', 'Value'], ['tries', '35 times'], ['wait', '250']]);
    expect(texts(box, 'td del')).toEqual(['3']);
    expect(texts(box, 'td ins')).toEqual(['5', 'wait', '250']);
  });

  it('leaves a Mermaid diagram that changed to be drawn as it was and as it is, each named and neither marked, its source compared under it', () => {
    const fence = (to: string): string => `# Flow\n\n\`\`\`mermaid\ngraph TD\n  A --> ${to}\n\`\`\`\n`;
    const box = drawn(fence('B'), fence('C'));
    const holders = [...box.querySelectorAll<HTMLElement>('[data-diff=drawn]')];
    expect(holders.map((h) => h.dataset.label)).toEqual(['Before', 'After']);
    expect(holders.map((h) => h.querySelector('code.language-mermaid')?.textContent?.trim())).toEqual(['graph TD\n  A --> B', 'graph TD\n  A --> C']);
    expect(box.querySelector('[data-diff=del], [data-diff=add]')).toBeNull();
    expect(texts(box, 'details del')).toEqual(['A --> B']);
    expect(texts(box, 'details ins')).toEqual(['A --> C']);
    expect(holders[0]?.querySelector('details'), 'under the one after').toBeNull();

    expect([...drawn('# Flow\n', fence('B')).querySelectorAll<HTMLElement>('[data-diff=drawn]')].map((h) => h.dataset.label)).toEqual(['Added']);
    expect([...drawn(fence('B'), '# Flow\n').querySelectorAll<HTMLElement>('[data-diff=drawn]')].map((h) => h.dataset.label)).toEqual(['Removed']);
  });

  it('shows a table whose columns changed as the old one gone and the new one added', () => {
    const box = drawn('| a | b |\n| --- | --- |\n| 1 | 2 |\n', '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n');
    expect(box.querySelectorAll('[data-diff=del] table, [data-diff=add] table')).toHaveLength(2);
  });

  it('side by side, puts each block beside what became of it: the old with what was taken out marked, the new with what was put in', () => {
    const box = document.createElement('div');
    box.innerHTML = renderMarkdownDiff('# Plan\n\nRetries are unbounded for now.\n\nDropped later.\n', '# Plan\n\nRetries are capped for now.\n\n## Risks\n', {}, true).html;
    const rows = [...box.querySelectorAll('[data-row]')].map((row) => [row.querySelector('[data-side=old]')?.textContent?.trim(), row.querySelector('[data-side=new]')?.textContent?.trim()]);
    expect(rows, 'a block put in another\'s place faces it').toEqual([['Plan', 'Plan'], ['Retries are unbounded for now.', 'Retries are capped for now.'], ['Dropped later.', 'Risks']]);
    expect(texts(box, '[data-side=old] del')).toEqual(['unbounded']);
    expect(texts(box, '[data-side=new] ins')).toEqual(['capped']);
    expect(box.querySelector('[data-side=old] ins, [data-side=new] del')).toBeNull();
  });

  it('side by side, leaves the place beside a block only one version has empty', () => {
    const box = document.createElement('div');
    box.innerHTML = renderMarkdownDiff('# Plan\n\nFirst.\n\nLast.\n', '# Plan\n\nFirst.\n\n## Risks\n\nLast.\n', {}, true).html;
    const rows = [...box.querySelectorAll('[data-row]')].map((row) => [row.querySelector('[data-side=old]')?.textContent?.trim(), row.querySelector('[data-side=new]')?.textContent?.trim()]);
    expect(rows).toEqual([['Plan', 'Plan'], ['First.', 'First.'], ['', 'Risks'], ['Last.', 'Last.']]);
  });

  it('is all added for a first version, and nothing marked for one that draws the same', () => {
    expect(texts(drawn(null, '# Plan\n\nFirst.\n'), '[data-diff=add]')).toEqual(['Plan', 'First.']);
    expect(renderMarkdownDiff('# Plan\n\nFirst.\n', '# Plan\n\n\nFirst.\n').changed).toBe(0);
  });
});
