import type { Index, Push } from '../lib/api';
import { parseRoute } from '../lib/route';
import { setPref, toast, useUI } from './ui';

/**
 * A notification when a push arrives. Latest's count is only in the page,
 * and `user` works in other windows most of the time, so a push went
 * unnoticed until they looked. Chrome hands a Notification to the system,
 * which shows it over whatever is in front. The page has to be open for
 * that, in the background or minimised: there is no push service behind it,
 * and none is wanted for a tool on this machine.
 *
 * A notification says only which task moved, its name as the title: `user`
 * opens the task to see what came. One per task, a later push replacing the
 * earlier, silent. Chrome asks its permission only on a click, so the bell by
 * Latest asks; whether to notify is this browser's choice, kept in its prefs.
 */

export const canNotify = (): boolean => typeof Notification !== 'undefined';
export const notifying = (): boolean => canNotify() && useUI.getState().prefs.notify && Notification.permission === 'granted';

/** The favicon as a bitmap: Chrome draws a notification's icon from one, not from SVG. */
let logoPng: Promise<string> | null = null;
function logoIcon(): Promise<string> {
  logoPng ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 192;
      c.getContext('2d')?.drawImage(img, 0, 0, 192, 192);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve('');
    img.src = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '';
  });
  return logoPng;
}

/** Whether the page is in front, showing where the task's push would be seen: the task itself, or Latest. */
function inFront(task: string): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const r = parseRoute(location.hash);
  return r.view === 'latest' || (r.view === 'task' && r.id === task);
}

let told: Map<string, number> | null = null;

/**
 * Tells of each task whose newest push is newer than the last one told of.
 * The first index fills the marks without telling: what was there when the
 * page opened is Latest's to show, not a burst of notifications.
 */
export function tellOfPushes(index: Index): void {
  const newest = new Map<string, Push>();
  for (const p of index.latest) if (p.at > (newest.get(p.task)?.at ?? 0)) newest.set(p.task, p);
  if (!told) {
    told = new Map([...newest].map(([task, p]) => [task, p.at]));
    return;
  }
  for (const [task, p] of newest) {
    if (p.at <= (told.get(task) ?? 0)) continue;
    told.set(task, p.at);
    if (notifying() && !inFront(task)) void notify(index, task, p);
  }
}

async function notify(index: Index, task: string, p: Push): Promise<void> {
  const t = index.tasks.find((x) => x.id === task);
  const icon = await logoIcon();
  let n: Notification;
  try {
    n = new Notification(t?.title ? `${t.title} · ${task}` : task, { tag: `yan:${task}`, silent: true, icon: icon || undefined });
  } catch {
    return; // Chrome on Android wants a service worker for these; this page is not for it
  }
  // Clicking opens Latest on the push, as the push's own line would.
  n.onclick = () => {
    n.close();
    window.focus();
    useUI.setState((s) => ({ feedOpen: [...s.feedOpen, `${task}@${p.at}`] }));
    location.hash = '#/latest';
  };
}

/** The bell: asks Chrome the first time, and after that turns notifying on and off for this browser. */
export async function toggleNotify(): Promise<void> {
  if (notifying()) {
    setPref('notify', false);
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Chrome blocks notifications from this page: allow them from the icon left of the address bar');
    return;
  }
  const got = await Notification.requestPermission();
  setPref('notify', got === 'granted');
  if (got === 'granted') toast('Chrome will say when a push arrives');
}
