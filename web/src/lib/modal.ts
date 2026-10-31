// A box over the page, as the page's own keys see it.

/**
 * Whether a box is open over the page: while one is, the keys are its, and
 * the page's own (Tab through a task's nav, ← and →, Enter into a terminal)
 * wait. Every such box says so with aria-modal.
 */
export const boxOpen = (): boolean => document.querySelector('[aria-modal="true"]') !== null;

/**
 * Tab and Shift+Tab kept inside `box`, going round from its last field or
 * button to its first and back. Returns whether it took the key.
 */
export function keepTab(e: { key: string; shiftKey: boolean; preventDefault: () => void }, box: HTMLElement | null): boolean {
  if (e.key !== 'Tab' || box === null) return false;
  const all = [...box.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea, a[href], [tabindex="0"]')];
  const [first, last] = [all[0], all[all.length - 1]];
  if (first === undefined || last === undefined) return false;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !box.contains(at))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (at === last || !box.contains(at))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
