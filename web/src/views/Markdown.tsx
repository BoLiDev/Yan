import { useEffect, useMemo, useRef, useState } from 'react';
import { langReady } from '../lib/highlight';
import { renderMarkdown, type MarkdownContext } from '../lib/markdown';
import { cn } from '../lib/utils';
import { filesOrigin, useTask } from '../state/server';
import { DOC } from './doc';

/**
 * Markdown as a document, with an outline beside it when asked for and it
 * has three headings or more, or bare, the text alone. The HTML is made once per text and put in
 * place whole: React leaves it alone until the text changes, so a push that
 * changes nothing in it changes nothing on screen.
 */
export function MarkdownDoc({ text, task, dir, before, dropTitle, outline, bare }: Omit<MarkdownContext, 'files' | 'filesOrigin'> & { text: string; outline?: boolean; bare?: boolean }) {
  const { data: d } = useTask(task);
  const files = d?.files;
  // Colouring waits for a fenced block's language: once it is loaded, the text is made again.
  const [loaded, setLoaded] = useState(0);
  const rendered = useMemo(
    () => renderMarkdown(text, { task, dir, files, filesOrigin: filesOrigin(), before, dropTitle }),
    // `loaded` stands for what renderMarkdown reads besides its arguments, the languages highlight.js has loaded:
    // one arriving makes it again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [text, task, dir, files, before, dropTitle, loaded],
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
  const heads = rendered.heads;
  // Bare, the text alone, for a page that has its own margins, and its width: the overview.
  if (bare) return <div className={DOC} ref={doc} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
  return (
    <div className="mx-auto flex max-w-[1080px] gap-8 px-10 pt-8 pb-20">
      <div className={`${DOC} max-w-[760px]`} ref={doc} dangerouslySetInnerHTML={{ __html: rendered.html }} />
      {outline && heads.length >= 3 ? (
        // Beside the text and staying in view as it scrolls; a page too narrow for both shows the text alone.
        <nav className="sticky top-4 flex w-[200px] flex-none flex-col gap-0.5 self-start text-[13px] leading-[19px] [@media(max-width:1280px)]:hidden" aria-label="Outline">
          <b className="px-2 pb-1.5 text-[12px] text-ink-3">On this page</b>
          {heads.map((x) => (
            // A third-level heading a step in, and dimmer, whether or not it is under the pointer.
            <a key={x.id} href="#" className={cn('truncate rounded-[6px] py-[3px] pr-2 no-underline hover:bg-sunken', x.level === 3 ? 'pl-5 text-ink-3' : 'pl-2 text-ink-2 hover:text-ink')} onClick={(e) => {
              e.preventDefault();
              doc.current?.querySelector(`#${CSS.escape(x.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}>{x.text}</a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
