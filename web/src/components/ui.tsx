import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { dirName, baseName } from '../lib/files';
import type { PushFile } from '../lib/api';
import { useUI, type Ask } from '../state/ui';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Input } from './ui/input';
import { cn } from '../lib/utils';
import { Icon, type IconName } from './Icon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Empty as EmptyState, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface ToolProps {
  name: IconName;
  label: string;
  onClick?: () => void;
  href?: string | null;
  /** A link opens in a new tab unless this is false. */
  newTab?: boolean;
  small?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  blocked?: boolean;
}

/**
 * An icon button, or an icon link when it has somewhere to go, named by its
 * tooltip; a link with nowhere to go is a button, so it can be disabled.
 */
export function Tool({ name, label, onClick, href, newTab = true, small, pressed, disabled, blocked }: ToolProps) {
  const look = cn('text-ink-3 hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground', blocked && 'opacity-40 hover:bg-transparent hover:text-ink-3');
  const size = small ? 'icon-sm' : 'icon';
  const icon = <Icon name={name} size={small ? 15 : 17} />;
  const trigger = href
    ? <Button variant="ghost" size={size} className={look} aria-label={label} nativeButton={false}
      render={<a href={href} target={newTab ? '_blank' : undefined} rel="noopener" onClick={onClick} />}>{icon}</Button>
    : <Button variant="ghost" size={size} className={look} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{icon}</Button>;
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One of a few, as a row of toggles; the one picked stays picked. */
export function Seg<V extends string>({ options, current, onPick, wide }: { options: readonly (readonly [V, string])[]; current: V; onPick: (v: V) => void; wide?: boolean }) {
  return (
    <ToggleGroup value={[current]} onValueChange={(next) => {
      if (next[0] !== undefined) onPick(next[0] as V);
    }} spacing={1} className={cn('rounded-lg bg-muted p-[3px]', wide && 'flex w-auto')}>
      {options.map(([value, label]) => (
        <ToggleGroupItem key={value} value={value} size="sm"
          className={cn('h-7 px-3 text-[13px] font-normal text-ink-2 hover:bg-transparent data-[pressed]:bg-card data-[pressed]:font-bold data-[pressed]:text-foreground data-[pressed]:shadow-xs', wide && 'flex-1')}>
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** The right pane's toolbar: what is shown, a line about it, and the tools for it. */
export function Bar({ title, meta, tools }: { title: ReactNode; meta?: ReactNode; tools?: ReactNode }) {
  return (
    <div className="bar">
      <div className="title"><span className="name">{title}</span><span className="meta">{meta ?? ''}</span></div>
      {tools}
    </div>
  );
}

export function Crumb({ path }: { path: string }) {
  const dir = dirName(path);
  return <>{dir ? <span className="dir">{dir} / </span> : null}{baseName(path)}</>;
}

/** What a pane says when it has nothing else to show: a title, and a line or two under it. */
export function Empty({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <EmptyState className="flex-1">
      <EmptyHeader>
        {title ? <EmptyTitle className="text-lg font-bold">{title}</EmptyTitle> : null}
        {children ? <EmptyDescription>{children}</EmptyDescription> : null}
      </EmptyHeader>
    </EmptyState>
  );
}

/** `+2 ~1 −1`: what a push added, changed and deleted, as tags. */
export function PushTags({ files }: { files: readonly PushFile[] }) {
  const n = (st: string): number => files.filter((f) => f.status === st).length;
  const tags = ([['A', 'success', '+', 'added'], ['M', 'brand', '~', 'changed'], ['D', 'destructive', '−', 'deleted']] as const).filter(([st]) => n(st) > 0);
  return <>{tags.map(([st, variant, sign, word]) => <Badge key={st} variant={variant} className="h-[18px] rounded-md px-1.5 tabular-nums" title={`${n(st)} ${word}`}>{`${sign}${n(st)}`}</Badge>)}</>;
}

/** Where each scrolling list was left, by what it lists, for when the page comes back to it. */
const scrolls = new Map<string, number>();

/**
 * A pane: what stays at its top, what scrolls below that, and what stays at
 * its foot. The top gets a line under it once anything has scrolled under.
 * With `remember`, the list goes back to where it was left the last time it
 * listed the same thing.
 */
export function Pane({ top, body, foot, remember }: { top: ReactNode; body: ReactNode; foot?: ReactNode; remember?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || remember === undefined) return;
    el.scrollTop = scrolls.get(remember) ?? 0;
    setEdge(el.scrollTop > 0);
  }, [remember]);
  return (
    <>
      <div className={'pane-top' + (edge ? ' edge' : '')}>{top}</div>
      <div className="pane-scroll" ref={scroller} onScroll={(e) => {
        const at = e.currentTarget.scrollTop;
        setEdge(at > 0);
        if (remember !== undefined) scrolls.set(remember, at);
      }}>{body}</div>
      {foot ? <div className="pane-foot">{foot}</div> : null}
    </>
  );
}

/**
 * A question over the page, answered by its button or let go. With a
 * `reason`, it also asks for a line, which the button waits for and which
 * the answer is given. Its button has the keyboard, so Enter answers it as
 * the click that asked it would; with a reason, the line has it.
 */
export function AskModal() {
  const ask = useUI((s) => s.ask);
  // The last question asked stays drawn while the box closes.
  const [held, setHeld] = useState<Ask | null>(ask);
  if (ask !== null && ask !== held) setHeld(ask);
  const [given, setGiven] = useState('');
  const action = useRef<HTMLButtonElement>(null);
  const line = useRef<HTMLInputElement>(null);
  const close = (): void => useUI.setState({ ask: null });
  const ready = !held?.reason || given.trim() !== '';
  const answer = (): void => {
    if (held === null || !ready) return;
    close();
    held.then(given.trim());
  };
  return (
    <AlertDialog open={ask !== null} onOpenChange={(open) => { if (!open) close(); }} onOpenChangeComplete={(open) => { if (!open) setGiven(''); }}>
      <AlertDialogContent initialFocus={held?.reason ? line : action}>
        <AlertDialogHeader>
          <AlertDialogTitle>{held?.title}</AlertDialogTitle>
          {held?.sub ? <AlertDialogDescription>{held.sub}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {held?.reason ? (
          <Input ref={line} aria-label={held.reason} placeholder={held.reason} value={given} onChange={(e) => setGiven(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              answer();
            }} />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction ref={action} variant="destructive" disabled={!ready} onClick={answer}>{held?.action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

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
