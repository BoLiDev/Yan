import { useSyncExternalStore } from 'react';

/** PROTOTYPE: state kept in the URL's search params, so every state has an address and survives a reload. */
const listeners = new Set<() => void>();
const subscribe = (f: () => void): (() => void) => {
  listeners.add(f);
  window.addEventListener('popstate', f);
  return () => {
    listeners.delete(f);
    window.removeEventListener('popstate', f);
  };
};

export function setParams(next: Record<string, string | null>): void {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(next)) {
    if (v === null) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  history.replaceState(null, '', u);
  for (const f of listeners) f();
}

export function useParam(name: string, fallback: string): [string, (v: string | null) => void] {
  const value = useSyncExternalStore(subscribe, () => new URL(location.href).searchParams.get(name) ?? fallback);
  return [value, (v) => setParams({ [name]: v })];
}
