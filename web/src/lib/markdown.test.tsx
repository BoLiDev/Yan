import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

/** The rendered HTML as the page will hold it, to look into. */
function shown(text: string, ctx: Parameters<typeof renderMarkdown>[1] = {}): HTMLElement {
  const box = document.createElement('div');
  box.innerHTML = renderMarkdown(text, ctx).html;
  return box;
}

describe('Markdown an agent wrote', () => {
  it('keeps what it says and drops what would run', () => {
    const doc = shown([
      'Plain words, **bold**, and [a link](https://example.com).',
      '',
      '<img src=x onerror="window.__ran=1">',
      '<svg><animate onbegin="window.__ran=2" attributeName="x" dur="1s"></animate></svg>',
      '<a href="javascript:window.__ran=3">js</a>',
      '<form action="/api/pull"><button>go</button></form>',
      '<iframe srcdoc="<script>parent.__ran=4</script>"></iframe>',
      '<script>window.__ran=5</script>',
      '',
      '- [x] a ticked item',
    ].join('\n'), { task: 't1', dir: '' });
    expect(doc.querySelector('strong')?.textContent).toBe('bold');
    expect(doc.querySelector('a[href="https://example.com"]')?.getAttribute('target')).toBe('_blank');
    expect(doc.querySelector('input[type=checkbox]')).not.toBeNull();
    expect(doc.querySelectorAll('script, iframe, form').length).toBe(0);
    expect([...doc.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((n) => n.startsWith('on'))).toEqual([]);
    expect(doc.innerHTML).not.toContain('javascript:');
  });

  it("loads nothing as it is read, and nothing from the page's own address once shown", async () => {
    const html = renderMarkdown('<img src="/api/hello?probe=read">\n\n![x](/blob/probe-read)').html;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const asked = performance.getEntriesByType('resource').map((e) => e.name);
    expect(asked.filter((name) => name.includes('probe'))).toEqual([]);
    expect(html).not.toMatch(/src="\/(?!\/)/);
  });

  it("points a picture beside it at the files origin and a link to another artifact at the page's own view of it", () => {
    const doc = shown('![shot](shot.png)\n\n[the other](../c5/notes.md)', {
      task: 't1',
      dir: 'artifacts/c4',
      files: [{ path: 'c5/notes.md' }],
      filesOrigin: 'http://localhost:4748',
    });
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('http://localhost:4748/tasks/t1/artifacts/c4/shot.png');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('#/t/t1/a/c5/notes.md');
  });

  it('lists its headings for the outline down to the fifth level, each with an id to go to', () => {
    const { heads, html } = renderMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n');
    expect(heads.map((h) => [h.text, h.level])).toEqual([['One', 1], ['Two', 2], ['Three', 3], ['Four', 4], ['Five', 5]]);
    const box = document.createElement('div');
    box.innerHTML = html;
    for (const h of heads) expect(box.querySelector(`#${h.id}`)?.textContent).toBe(h.text);
  });

  it('marks, when asked, the line of its source each block begins on, reading the text whole all the same', () => {
    const text = '# Title\n\nA paragraph\nover two lines.\n\n<details>\n<summary>more</summary>\n\n- one\n- two\n\n</details>\n\n```ts\nconst x = 1;\n```\n';
    const doc = shown(text, { lines: true });
    const at = (el: Element | null): number | undefined => {
      let m = el?.previousElementSibling;
      while (m && !m.hasAttribute('data-line')) m = m.previousElementSibling;
      return m ? Number(m.getAttribute('data-line')) : undefined;
    };
    expect(at(doc.querySelector('h1'))).toBe(0);
    expect(at(doc.querySelector('p'))).toBe(2);
    expect(at(doc.querySelector('ul'))).toBe(8);
    expect(at(doc.querySelector('pre'))).toBe(13);
    expect(doc.querySelector('details ul'), 'the list still inside what was left open').not.toBeNull();
    expect(shown(text).querySelector('[data-line]'), 'and none unless asked').toBeNull();
  });

  it('tints the blocks new since the last look, each block read on its own', () => {
    const before = new Set(['# Title', 'Old paragraph.']);
    const doc = shown('Old paragraph.\n\nNew paragraph.\n\n<div>left open', { before });
    const fresh = [...doc.querySelectorAll('[data-fresh]')].map((el) => el.textContent?.trim());
    expect(fresh).toEqual(['New paragraph.', 'left open']);
    expect(doc.querySelector('[data-fresh]')?.previousElementSibling?.textContent).toBe('Old paragraph.');
  });
});
