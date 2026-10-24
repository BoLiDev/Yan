import { useEffect, useMemo, useRef, useState } from 'react';
import { langReady } from '../lib/highlight';
import { renderMarkdown, type MarkdownContext } from '../lib/markdown';
import { filesOrigin, useTask } from '../state/server';

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
    // `loaded` is in the list so a language arriving makes it again.
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
  // Bare, the text alone, for a page that has its own margins: the overview.
  if (bare) return <div className="doc" ref={doc} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
  return (
    <div className="doc-wrap">
      <div className="doc" ref={doc} dangerouslySetInnerHTML={{ __html: rendered.html }} />
      {outline && heads.length >= 3 ? (
        <nav className="outline" aria-label="Outline">
          <b>On this page</b>
          {heads.map((x) => (
            <a key={x.id} href="#" className={x.level === 3 ? 'l3' : ''} onClick={(e) => {
              e.preventDefault();
              doc.current?.querySelector(`#${CSS.escape(x.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}>{x.text}</a>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
