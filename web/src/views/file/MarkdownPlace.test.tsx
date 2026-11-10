import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactFile } from '../../lib/api';
import { detail, draw, have, index, reset, serve, task } from '../../testing/serve';
import { FileView } from '../File';

/** Forty parts, each a heading and a paragraph of short lines, so a line of the source is one row of its box. */
const text = Array.from({ length: 40 }, (_, i) => `## Part ${i + 1}\n\n${Array.from({ length: 6 }, (_, j) => `Line ${j + 1} of part ${i + 1}.`).join('\n')}\n`).join('\n');
const lineOf = (heading: string): number => text.slice(0, text.indexOf(heading)).split('\n').length - 1;
const file: ArtifactFile = { path: 'notes.md', sha: 'm1', size: text.length, added: 1, changed: 1, commit: 'c1' };
const other: ArtifactFile = { path: 'other.md', sha: 'o1', size: 9, added: 1, changed: 1, commit: 'c1' };
/** The same file, an agent having written twelve lines above all of it. */
const grown = `## Opening\n\n${Array.from({ length: 9 }, (_, j) => `An opening line ${j + 1}.`).join('\n')}\n\n${text}`;
const changed: ArtifactFile = { ...file, sha: 'm2', size: grown.length };

/** `f` drawn as the file view draws it, in a box 600 high. */
const view = (f: ArtifactFile) => (
  <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
    <FileView task="t1" file={f} prev={null} next={null} pos={1} total={1} folderFiles={[f]} fileHref={(p) => `#${p}`} />
  </div>
);
/** How far from the top of what scrolls a heading is: near 0 when it is what is being read. */
const fromTop = (h: Element): number => Math.abs(h.getBoundingClientRect().top - (h.closest('.overflow-auto') as HTMLElement).getBoundingClientRect().top);
/** The source's box sets a line 21 pixels tall, below 16 of padding. */
const ROW = 21;

describe('a Markdown file swapped between Rendered and Source', () => {
  afterEach(reset);

  it('opens each at the place the other was being read', async () => {
    serve({ '/blob/m1': new Response(text) });
    have(index([task('t1', 'notes')]), [detail('t1')]);
    const screen = await draw(
      <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
        <FileView task="t1" file={file} prev={null} next={null} pos={1} total={1} folderFiles={[file]} fileHref={(p) => `#${p}`} />
      </div>,
    );

    // Read down to part 30, then swap to the source: it opens on part 30's heading.
    const thirty = screen.getByRole('heading', { name: 'Part 30' });
    await expect.element(thirty).toBeInTheDocument();
    thirty.element().scrollIntoView({ block: 'start' });
    await screen.getByText('Source').click();
    const area = screen.getByRole('textbox', { name: /notes\.md/ });
    await expect.element(area).toBeVisible();
    const box = area.element() as HTMLTextAreaElement;
    await expect.poll(() => Math.abs(box.scrollTop / ROW - lineOf('## Part 30'))).toBeLessThan(2);

    // Scrolled in the source up to part 10, and swapped back: the rendered text opens on part 10.
    box.scrollTop = lineOf('## Part 10') * ROW;
    await screen.getByText('Rendered').click();
    const ten = screen.getByRole('heading', { name: 'Part 10' });
    await expect.element(ten).toBeInTheDocument();
    const scroller = ten.element().closest('.overflow-auto') as HTMLElement;
    await expect.poll(() => Math.abs(ten.element().getBoundingClientRect().top - scroller.getBoundingClientRect().top)).toBeLessThan(40);
  });

  it('opens a file again where it was left, after another was read', async () => {
    serve({ '/blob/m1': new Response(text), '/blob/o1': new Response('# Other\n') });
    have(index([task('t1', 'notes')]), [detail('t1')]);
    const screen = await draw(view(file));
    const thirty = screen.getByRole('heading', { name: 'Part 30' });
    await expect.element(thirty).toBeInTheDocument();
    thirty.element().scrollIntoView({ block: 'start' });
    // Noted as it is scrolled, a frame later.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    await screen.rerender(view(other));
    await expect.element(screen.getByRole('heading', { name: 'Other' })).toBeInTheDocument();
    await screen.rerender(view(file));
    await expect.element(screen.getByRole('heading', { name: 'Part 30' })).toBeInTheDocument();
    await expect.poll(() => fromTop(screen.getByRole('heading', { name: 'Part 30' }).element())).toBeLessThan(40);
  });

  it('stays at what is being read when an agent writes above it', async () => {
    serve({ '/blob/m1': new Response(text), '/blob/m2': new Response(grown) });
    have(index([task('t1', 'notes')]), [detail('t1')]);
    const screen = await draw(view(file));
    const thirty = screen.getByRole('heading', { name: 'Part 30' });
    await expect.element(thirty).toBeInTheDocument();
    thirty.element().scrollIntoView({ block: 'start' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    await screen.rerender(view(changed));
    await expect.element(screen.getByRole('heading', { name: 'Opening' })).toBeInTheDocument();
    await expect.poll(() => fromTop(screen.getByRole('heading', { name: 'Part 30' }).element())).toBeLessThan(40);
  });
});
