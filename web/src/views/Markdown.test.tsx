import { afterEach, describe, expect, it } from 'vitest';
import { draw, have, index, reset } from '../testing/serve';
import { MarkdownDoc } from './Markdown';

describe('a Markdown document', () => {
  afterEach(reset);

  it('keeps a long run with no space in it, code in a line or an address, within the text, off the outline beside it', async () => {
    have(index([]));
    const long = `YAN_${'A_VERY_LONG_NAME_WITH_NO_SPACE_IN_IT_'.repeat(8)}END`;
    const text = `# One\n\nSee \`${long}\` for it, and https://example.com/${'aPathThatGoesOn'.repeat(12)} too.\n\n## Two\n\ntext\n\n## Three\n\ntext\n`;
    const screen = await draw(<div style={{ width: 700 }}><MarkdownDoc text={text} outline /></div>);
    await expect.element(screen.getByRole('heading', { name: 'Three' })).toBeVisible();
    const doc = document.querySelector('h1')?.parentElement as HTMLElement;
    const edge = doc.getBoundingClientRect().right;
    for (const el of doc.querySelectorAll('code, a')) expect(Math.round(el.getBoundingClientRect().right), el.tagName).toBeLessThanOrEqual(Math.round(edge));
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  });
});
