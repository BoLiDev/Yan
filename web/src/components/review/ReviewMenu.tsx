import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useHash } from '../../lib/route';
import { cn } from '../../lib/utils';
import { useComments, useReview } from '../../state/review';
import { copyText } from '../../state/ui';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import type { Located } from './locate';
import { useReviewMarks } from './marks';

/** What was selected as the menu opened: as it reads, as the document holds it, and where. */
interface Picked {
  readonly quote: string;
  readonly range: Range;
}

/**
 * Something read on the page that can be commented on: with some of it
 * selected, a right click opens the page's own menu in place of the
 * browser's, to comment on what is selected, which joins the task's review,
 * to copy it, or, where it can be (`onEdit`), to edit it. With nothing
 * selected the browser's menu opens as ever, a link's or a picture's.
 * `locate` says where a selection is, for the comment to say; what has
 * been commented on already is marked.
 */
export function ReviewMenu({ task, locate, onEdit, className, children }: {
  task: string;
  locate: (range: Range, box: HTMLElement) => Located;
  onEdit?: (range: Range, quote: string, box: HTMLElement) => void;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const hash = useHash();
  const all = useComments(task);
  const here = useMemo(() => all.filter((c) => c.href === hash), [all, hash]);
  useReviewMarks(box, here);

  const comment = (): void => {
    if (picked === null || box.current === null) return;
    const at = locate(picked.range, box.current);
    useReview.setState({ drafting: { task, where: at.where, quote: picked.quote, exact: picked.range.toString(), href: location.hash, ...(at.code ? { code: true } : {}) } });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div ref={box} />} className={cn('select-text', className)} onContextMenu={(e) => {
        const sel = getSelection();
        const range = sel !== null && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
        const quote = sel?.toString() ?? '';
        // Nothing of this selected: the browser's own menu, as on any page.
        if (range === null || quote.trim() === '' || !e.currentTarget.contains(range.commonAncestorContainer)) return void (e as typeof e & { preventBaseUIHandler: () => void }).preventBaseUIHandler();
        setPicked({ quote, range: range.cloneRange() });
      }}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onClick={comment}>Comment</ContextMenuItem>
        <ContextMenuItem onClick={() => { if (picked) copyText(picked.quote, 'Copied', 'Copy what was selected'); }}>Copy</ContextMenuItem>
        {onEdit ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => { if (picked && box.current) onEdit(picked.range, picked.quote, box.current); }}>Edit</ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
