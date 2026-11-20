import type { Index, Push } from '../lib/api';
import { parseRoute } from '../lib/route';
import { message, setPref, toast, useUI } from './ui';

/**
 * A notification when a push arrives. The marks on what is new are only in
 * the page, and `user` works in other windows most of the time, so a push
 * went unnoticed until they looked. Chrome hands a Notification to the system,
 * which shows it over whatever is in front. The page has to be open for
 * that, in the background or minimised: there is no push service behind it,
 * and none is wanted for a tool on this machine.
 *
 * A notification says only which task moved, its name as the title: `user`
 * opens the task to see what came. One per task, a later push replacing the
 * earlier, silent. Chrome asks its permission only on a click, so the switch in
 * the settings asks; whether to notify is this browser's choice, kept in its prefs.
 *
 * That one switch is all the page's telling: off, the page tells nothing of
 * an agent that finished either, in a toast or a bubble (`agentToasts.ts`),
 * since someone who wants no interruptions wants none of them. On without
 * Chrome's leave, the page still tells in itself, and only Chrome is silent.
 */

/** Whether `user` wants to be told at all, by the page or by Chrome. */
export const telling = (): boolean => useUI.getState().prefs.notify;


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

/** Whether the page is in front, showing where the task's push would be seen: the task itself. */
function inFront(task: string): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const r = parseRoute(location.hash);
  return r.view === 'task' && r.id === task;
}

let told: Map<string, number> | null = null;

/**
 * Tells of each task whose newest push is newer than the last one told of.
 * The first index fills the marks without telling: what was there when the
 * page opened is marked in it, not told in a burst of notifications.
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
    if (notifying() && !inFront(task)) void notify(index, task);
  }
}

async function notify(index: Index, task: string): Promise<void> {
  const t = index.tasks.find((x) => x.id === task);
  const icon = await logoIcon();
  let n: Notification;
  try {
    n = new Notification(t?.title ? `${t.title} · ${task}` : task, { tag: `yan:${task}`, silent: true, icon: icon || undefined });
  } catch {
    return; // Chrome on Android wants a service worker for these; this page is not for it
  }
  // Clicking opens the task, where what came is marked.
  n.onclick = () => {
    n.close();
    window.focus();
    location.hash = `#/t/${task}`;
  };
}

/** The settings' switch: turns telling on and off for this browser, asking Chrome's leave the first time it is turned on. */
export async function toggleNotify(): Promise<void> {
  if (telling()) {
    setPref('notify', false);
    return;
  }
  setPref('notify', true);
  if (!canNotify()) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') message.success('Chrome will say when a push arrives');
  else toast('The page will tell you here. Chrome blocks its own notifications from this page: allow them from the icon left of the address bar');
}
