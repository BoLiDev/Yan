import { useEffect, useMemo, useRef, useState } from 'react';
import { useDiagrams } from '../lib/diagrams';
import { langReady } from '../lib/highlight';
import { renderMarkdown, type Heading, type MarkdownContext } from '../lib/markdown';
import { cn } from '../lib/utils';
import { filesOrigin, useTask } from '../state/server';
import { DOC } from './doc';

/**
 * How many steps in an outline row is: none for the first two levels, as a
 * title and the parts under it, then one for each level below; counted from
 * the highest level the text has, when that is below the second.
 */
function depthOf(level: number, heads: readonly Heading[]): number {
  const top = Math.max(2, Math.min(...heads.map((h) => h.level)));
  return Math.max(0, level - top);
}

/**
 * Markdown as a document, with an outline beside it, down to the fifth
 * level of heading, when asked for and it has three headings or more, or bare, the text alone. The HTML is made once per text and put in
 * place whole: React leaves it alone until the text changes, so a push that
 * changes nothing in it changes nothing on screen. Its Mermaid fences are
 * drawn once it is in place.
 */
export function MarkdownDoc({ text, task, base, dir, before, dropTitle, lines, outline, bare }: Omit<MarkdownContext, 'files' | 'filesOrigin'> & { text: string; outline?: boolean; bare?: boolean }) {
  const { data: d } = useTask(task);
  const files = d?.files;
  // Colouring waits for a fenced block's language: once it is loaded, the text is made again.
  const [loaded, setLoaded] = useState(0);
  const rendered = useMemo(
    () => renderMarkdown(text, { task, base, dir, files, filesOrigin: filesOrigin(), before, dropTitle, lines }),
    // `loaded` stands for what renderMarkdown reads besides its arguments, the languages highlight.js has loaded:
    // one arriving makes it again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [text, task, base, dir, files, before, dropTitle, lines, loaded],
  );
  useEffect(() => {
    if (!rendered.waiting.length) return;
    let live = true;
    void Promise.all(rendered.waiting.map(langReady)).then(() => {
      if (live) setLoaded((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [rendered.waiting]);
  const doc = useRef<HTMLDivElement>(null);
  useDiagrams(doc, rendered.html);
  const heads = rendered.heads;
  // Bare, the text alone, for a page that has its own margins, and its width: the overview.
  if (bare) return <div className={DOC} ref={doc} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
  return (
    <div className="mx-auto flex max-w-[1080px] gap-8 px-10 pt-8 pb-20">
      <div className={`${DOC} max-w-[760px]`} ref={doc} dangerouslySetInnerHTML={{ __html: rendered.html }} />
      {outline && heads.length >= 3 ? (
        // Beside the text and staying in view as it scrolls, scrolling on its own when it is longer than the view;
        // a page too narrow for both shows the text alone.
        <nav className="sticky top-4 flex max-h-[calc(100vh-10rem)] w-[200px] flex-none flex-col gap-0.5 self-start overflow-y-auto overscroll-contain text-[13px] leading-[19px] [@media(max-width:1280px)]:hidden" aria-label="Outline">
          <b className="shrink-0 px-2 pb-1.5 text-[12px] text-ink-3">On this page</b>
          {heads.map((x) => (
            // Each level below the second a step further in, and dimmer, whether or not it is under the pointer;
            // a text whose headings begin lower starts its steps there.
            <a key={x.id} href="#" title={x.text} style={{ paddingLeft: 8 + depthOf(x.level, heads) * 12 }}
              className={cn('shrink-0 truncate rounded-[6px] py-[3px] pr-2 no-underline hover:bg-sunken', depthOf(x.level, heads) > 0 ? 'text-ink-3' : 'text-ink-2 hover:text-ink')} onClick={(e) => {
              e.preventDefault();
              doc.current?.querySelector(`#${CSS.escape(x.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}>{x.text}</a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
