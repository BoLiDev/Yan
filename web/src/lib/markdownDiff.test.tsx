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

  it('shows a fence or a table that changed as the old one gone and the new one added, not word by word', () => {
    const box = drawn('```js\nconst n = 1;\n```\n', '```js\nconst n = 5;\n```\n');
    expect(texts(box, '[data-diff=del] pre')).toEqual(['const n = 1;']);
    expect(texts(box, '[data-diff=add] pre')).toEqual(['const n = 5;']);
    expect(box.querySelector('ins, del')).toBeNull();
  });

  it('side by side, puts each block beside what became of it: the old with what was taken out marked, the new with what was put in', () => {
    const box = document.createElement('div');
    box.innerHTML = renderMarkdownDiff('# Plan\n\nRetries are unbounded for now.\n\nDropped later.\n', '# Plan\n\nRetries are capped for now.\n\n## Risks\n', {}, true).html;
    const rows = [...box.querySelectorAll('[data-row]')].map((row) => [row.querySelector('[data-side=old]')?.textContent?.trim(), row.querySelector('[data-side=new]')?.textContent?.trim()]);
    expect(rows).toEqual([['Plan', 'Plan'], ['Retries are unbounded for now.', 'Retries are capped for now.'], ['Dropped later.', ''], ['', 'Risks']]);
    expect(texts(box, '[data-side=old] del')).toEqual(['unbounded']);
    expect(texts(box, '[data-side=new] ins')).toEqual(['capped']);
    expect(box.querySelector('[data-side=old] ins, [data-side=new] del')).toBeNull();
  });

  it('is all added for a first version, and nothing marked for one that draws the same', () => {
    expect(texts(drawn(null, '# Plan\n\nFirst.\n'), '[data-diff=add]')).toEqual(['Plan', 'First.']);
    expect(renderMarkdownDiff('# Plan\n\nFirst.\n', '# Plan\n\n\nFirst.\n').changed).toBe(0);
  });
});
