/**
 * Markdown as a document: marked writes its HTML, so there is no element to
 * put a utility on, and each part is reached from the document's own
 * element, one selector to a line. Text a little larger than the page's and
 * set loose, to be read; headings in ink, tighter, and stopping short of the
 * top when the outline scrolls to one.
 */
export const DOC = [
  'min-w-0 flex-auto text-[15px] leading-[27px] text-[color:var(--doc-ink)]',
  '[&_:is(h1,h2,h3,h4)]:scroll-mt-4 [&_:is(h1,h2,h3,h4)]:leading-[1.35] [&_:is(h1,h2,h3,h4)]:tracking-[-0.01em] [&_:is(h1,h2,h3,h4)]:text-ink',
  '[&_h1]:mb-[18px] [&_h1]:text-[26px]',
  '[&_h2]:mt-[34px] [&_h2]:mb-3 [&_h2]:border-b [&_h2]:border-sunken [&_h2]:pb-1.5 [&_h2]:text-[20px]',
  '[&_h3]:mt-[26px] [&_h3]:mb-2 [&_h3]:text-[16.5px]',
  '[&_h4]:mt-[18px] [&_h4]:mb-1.5 [&_h4]:text-[15px]',
  '[&_p]:mb-3.5',
  '[&_:is(ul,ol)]:mb-3.5 [&_:is(ul,ol)]:pl-6',
  '[&_ul]:list-disc',
  '[&_ol]:list-decimal',
  '[&_li]:my-0.5',
  '[&_li>p]:mb-1.5',
  // Code in a line: a little smaller than the words around it, regular and upright whatever they are set in, and no taller than it needs.
  '[&_code]:rounded-[5px] [&_code]:bg-sunken [&_code]:px-[5px] [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:leading-normal [&_code]:font-normal [&_code]:not-italic',
  '[&_pre]:mb-4 [&_pre]:overflow-auto [&_pre]:rounded-[10px] [&_pre]:bg-[var(--code-bg)] [&_pre]:px-4 [&_pre]:py-3.5 [&_pre]:font-mono [&_pre]:text-[12.5px] [&_pre]:leading-5 [&_pre]:font-normal [&_pre]:ring-1 [&_pre]:ring-border',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:[font-size:inherit]',
  '[&_blockquote]:mb-3.5 [&_blockquote]:border-l-3 [&_blockquote]:border-border [&_blockquote]:px-4 [&_blockquote]:py-0.5 [&_blockquote]:text-ink-3',
  // A table wider than the text scrolls on its own, rather than the document.
  '[&_table]:mb-4 [&_table]:block [&_table]:border-collapse [&_table]:overflow-x-auto [&_table]:text-[13.5px] [&_table]:leading-[21px]',
  '[&_:is(th,td)]:border [&_:is(th,td)]:border-border [&_:is(th,td)]:px-2.5 [&_:is(th,td)]:py-1.5 [&_:is(th,td)]:text-left [&_:is(th,td)]:align-top',
  '[&_th]:bg-[var(--raised)]',
  '[&_img]:max-w-full [&_img]:rounded-[8px] [&_img]:ring-1 [&_img]:ring-border',
  '[&_hr]:my-6 [&_hr]:border-t [&_hr]:border-border',
  // A block new since the last look, tinted out to a little past the text on either side.
  '[&_[data-fresh]]:-mx-3.5 [&_[data-fresh]]:mb-3 [&_[data-fresh]]:rounded-[10px] [&_[data-fresh]]:bg-brand-wash [&_[data-fresh]]:px-3.5 [&_[data-fresh]]:pt-2 [&_[data-fresh]]:pb-px',
].join(' ');
