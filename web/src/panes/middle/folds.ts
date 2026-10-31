// What of a task's column is open or folded, kept in the store for this visit.

import { toggled, useUI } from '../../state/ui';

const NONE: readonly string[] = [];

/** A task's artifacts folders that are open, as last left; every one starts closed. */
export function useOpenFolders(id: string): readonly string[] {
  return useUI((s) => s.open[id]) ?? NONE;
}

export function setFolder(key: string, start: readonly string[], path: string, open: boolean): void {
  useUI.setState((s) => ({ open: { ...s.open, [key]: toggled(s.open[key] ?? start, path, open) } }));
}

const revealed = new Map<string, string>();
/** True the first time `item` is asked for under `key`, so its folders open then and can be closed after. */
export function revealOnce(key: string, item: string): boolean {
  if (revealed.get(key) === item) return false;
  revealed.set(key, item);
  return true;
}

/** A row that folds, folded if it was open and opened if it was folded. */
export function flip(key: string, now: boolean): void {
  useUI.setState((s) => ({ unfolded: { ...s.unfolded, [key]: !now } }));
}
