import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { matchText } from '../lib/find';
import { AntIcon, Icon } from './Icon';
import { Marked } from './Palette';

/**
 * A select of several, as antd's is: what is picked as tags in the field,
 * with a search typed beside them; a click, ↓ or typing opens the list
 * under it, what is typed narrowing it as ⌘K narrows the tasks, what is
 * picked ticked. A click on an option picks or drops it and keeps the list
 * open; Enter picks the one the keyboard is on, then the list closes and the
 * search clears, so the next Enter is the form's. Backspace in an empty
 * search drops the last tag; Escape closes the list before anything else.
 * The list hangs from the field over whatever is around it, so a box that
 * clips its own body does not clip it.
 */
export function MultiSelect({ options, value, onChange, empty, label, autoFocus = false }: {
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** What the field says with nothing picked, when that means something. */
  empty?: string;
  label: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The option the keyboard is on; none until it moves or something is typed, so Enter alone is the form's.
  const [at, setAt] = useState(-1);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);

  const shown = query.trim() === ''
    ? options.map((o) => ({ value: o, marks: [] as readonly (readonly [number, number])[] }))
    : options.flatMap((o) => {
      const m = matchText(o, query);
      return m === undefined ? [] : [{ value: o, marks: m.marks, score: m.score }];
    }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Taking the keyboard as its step comes, it shows what there is to pick at once.
  useEffect(() => {
    if (!autoFocus) return;
    input.current?.focus();
    setOpen(true);
  }, [autoFocus]);

  // The list follows the field while it is open, as the box around it springs and slides.
  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const follow = (): void => {
      const r = field.current?.getBoundingClientRect();
      if (r) setPlace((p) => (p && p.left === r.left && p.top === r.bottom + 4 && p.width === r.width ? p : { left: r.left, top: r.bottom + 4, width: r.width }));
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // A click anywhere but the field and its list closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!field.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [open]);

  useLayoutEffect(() => {
    list.current?.querySelector('.ms-opt.at')?.scrollIntoView({ block: 'nearest' });
  }, [at, open]);

  const toggle = (o: string): void => onChange(value.includes(o) ? value.filter((v) => v !== o) : [...value, o]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
      setAt((a) => Math.max(0, Math.min(shown.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && !(e.metaKey || e.ctrlKey) && open && shown[at] !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      toggle((shown[at] as { value: string }).value);
      setQuery('');
      setAt(-1);
      setOpen(false);
    } else if (e.key === 'Escape' && (open || query !== '')) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery('');
      setAt(-1);
    } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <>
      <div ref={field} className={'ms-field' + (open ? ' open' : '')} onMouseDown={(e) => {
        if (e.target !== input.current) e.preventDefault();
        input.current?.focus();
        setOpen((o) => !o || e.target === input.current);
      }}>
        {value.map((v) => (
          <span key={v} className="ms-tag">
            {v}
            <button type="button" tabIndex={-1} aria-label={`去掉 ${v}`} onMouseDown={(e) => e.stopPropagation()} onClick={() => toggle(v)}><AntIcon name="close" size={9} /></button>
          </span>
        ))}
        <input ref={input} value={query} aria-label={label} spellCheck={false} autoComplete="off" role="combobox" aria-expanded={open}
          placeholder={value.length === 0 ? (empty ?? '') : ''}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setAt(e.target.value.trim() === '' ? -1 : 0);
          }}
          onKeyDown={onKey} />
        <Icon name="down" size={14} />
      </div>
      {open && place !== null ? createPortal(
        <div ref={list} className="ms-list" role="listbox" aria-label={label} aria-multiselectable style={{ left: place.left, top: place.top, width: place.width }}
          onMouseDown={(e) => e.preventDefault()}>
          {shown.length === 0 ? <div className="ms-none">没有匹配的</div> : shown.map((o, i) => (
            <div key={o.value} role="option" aria-selected={value.includes(o.value)} className={'ms-opt' + (i === at ? ' at' : '') + (value.includes(o.value) ? ' on' : '')}
              onMouseMove={() => setAt(i)} onClick={() => toggle(o.value)}>
              <span className="ms-name"><Marked text={o.value} marks={o.marks} /></span>
              {value.includes(o.value) ? <AntIcon name="check" size={12} /> : null}
            </div>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
