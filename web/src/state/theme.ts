import { useSyncExternalStore } from 'react';
import { useUI } from './ui';

/**
 * Light or dark: what the browser asks for, unless this browser was told
 * otherwise (prefs.theme). The page is drawn by index.css's tokens, which
 * follow the browser by themselves; told dark, <html> carries `.dark`, told
 * light `.light`, and following the browser into dark, `.dark` too, so
 * shadcn's own `dark:` touches go with it.
 */
export type Theme = 'system' | 'light' | 'dark';

const media = (): MediaQueryList | undefined => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined);

/** Light or dark, as the page is drawn now. */
export function themeNow(): 'light' | 'dark' {
  const theme = useUI.getState().prefs.theme;
  return theme === 'dark' || (theme === 'system' && media()?.matches === true) ? 'dark' : 'light';
}

function apply(): void {
  const theme = useUI.getState().prefs.theme;
  const root = document.documentElement;
  root.classList.toggle('dark', themeNow() === 'dark');
  root.classList.toggle('light', theme === 'light');
}

const listeners = new Set<() => void>();
function told(): void {
  apply();
  for (const l of listeners) l();
}

/** Draw the page in the theme asked for, and keep doing so as the preference or the browser changes. */
export function followTheme(): void {
  apply();
  media()?.addEventListener('change', told);
  useUI.subscribe((s, before) => {
    if (s.prefs.theme !== before.prefs.theme) told();
  });
}

/** Light or dark as the page is drawn, redrawing whatever reads it when that changes. */
export function useTheme(): 'light' | 'dark' {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, themeNow);
}
