import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '../ui/context-menu';

/** What opens and closes a `PickMenu` from outside it. */
export interface PickMenuApi {
  /** Open the menu at a point of the page. */
  open(x: number, y: number): void;
  close(): void;
}

/**
 * The page's own menu over something the page cannot read a selection in
 * by itself: a page in a frame on another origin, a report in a shadow
 * root. Whatever watches that part says what was picked and where, and
 * opens the menu there (`api`); a right click the part did not answer for,
 * on the room around it, is the browser's as ever. `menu` is its items.
 */
export function PickMenu({ api, menu, className, children }: { api: Ref<PickMenuApi>; menu: ReactNode; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useImperativeHandle(api, () => ({
    // The menu is Base UI's, which opens on a right click on its trigger and stands where the click was: it is given one.
    open: (x, y) => void box.current?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y })),
    close: () => setOpen(false),
  }), []);
  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger render={<div ref={box} />} className={className} onContextMenu={(e) => {
        if (e.isTrusted) (e as typeof e & { preventBaseUIHandler: () => void }).preventBaseUIHandler();
      }}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}
