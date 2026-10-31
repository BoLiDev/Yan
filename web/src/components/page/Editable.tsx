import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * A text edited where it stands: Enter or leaving it keeps what was typed,
 * on one line, and Escape puts it back. A blank is never kept. While it is
 * being edited, a new text from the server waits: what is typed is never
 * overwritten under the typist.
 */
export function Editable({ text, onSave, onLeft, className, as = 'span', autoFocus }: {
  text: string;
  onSave: (text: string) => void;
  onLeft?: (changed: boolean) => void;
  className?: string;
  as?: 'span' | 'div';
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const was = useRef(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.textContent = text;
  }, [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !autoFocus) return;
    el.focus();
    getSelection()?.selectAllChildren(el);
  }, [autoFocus]);
  const Tag = as;
  return (
    <Tag ref={ref as never} className={className} contentEditable="plaintext-only" spellCheck={false} suppressContentEditableWarning
      onFocus={(e) => { was.current = e.currentTarget.textContent ?? ''; }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') {
          e.currentTarget.textContent = was.current;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        const el = e.currentTarget;
        const typed = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        const changed = typed !== was.current.trim() && typed !== '';
        if (typed === '') el.textContent = was.current;
        if (changed) {
          was.current = typed;
          onSave(typed);
        }
        onLeft?.(changed);
      }} />
  );
}
