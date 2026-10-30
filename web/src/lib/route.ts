import { useMemo, useSyncExternalStore } from 'react';
import { enc } from './files';

/**
 * Where the page is, kept in the URL's hash, so back, forward and a reload
 * all land where they were.
 *
 *   #/latest                         what arrived
 *   #/latest/<task>/<path>           one of its files
 *   #/t/<task>                       a task's overview
 *   #/t/<task>/log | /report | /agent
 *   #/t/<task>/a/<path>              an artifact; a path ending in / is a folder
 *   #/t/<task>/b/<repo>/<tab>/<item> the branch the tree was last on
 *   #/t/<task>/b/<repo>/<branch>/<tab>/<item>  another of the task's branches
 */

export const BRANCH_TABS = ['changes', 'commits', 'files'] as const;
export type BranchTab = (typeof BRANCH_TABS)[number];

export type Route =
  | { readonly view: 'latest'; readonly id?: string; readonly path?: string }
  | { readonly view: 'task'; readonly id: string; readonly sub: 'overview' | 'log' | 'report' | 'agent' }
  | { readonly view: 'task'; readonly id: string; readonly sub: 'file' | 'folder'; readonly path: string }
  | { readonly view: 'task'; readonly id: string; readonly sub: 'branch'; readonly repo: number; readonly name: string | null; readonly tab: BranchTab; readonly item: string };

export type TaskRoute = Extract<Route, { view: 'task' }>;
export type BranchRoute = Extract<Route, { sub: 'branch' }>;

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  let parts: string[];
  try {
    parts = raw.split('/').map(decodeURIComponent);
  } catch {
    parts = [];
  }
  if (parts[0] === 't' && parts[1]) {
    const id = parts[1];
    const rest = parts.slice(2);
    if (rest[0] === 'log') return { view: 'task', id, sub: 'log' };
    if (rest[0] === 'report') return { view: 'task', id, sub: 'report' };
    if (rest[0] === 'agent') return { view: 'task', id, sub: 'agent' };
    if (rest[0] === 'a') {
      const p = rest.slice(1).join('/');
      if (p === '' || raw.endsWith('/')) return { view: 'task', id, sub: 'folder', path: p.replace(/\/$/, '') };
      return { view: 'task', id, sub: 'file', path: p };
    }
    if (rest[0] === 'b') {
      const named = rest[2] !== undefined && !(BRANCH_TABS as readonly string[]).includes(rest[2]);
      const at = named ? 3 : 2;
      const tab = (BRANCH_TABS as readonly string[]).includes(rest[at] ?? '') ? (rest[at] as BranchTab) : 'changes';
      return { view: 'task', id, sub: 'branch', repo: Number(rest[1]) || 0, name: named ? (rest[2] as string) : null, tab, item: rest.slice(at + 1).join('/') };
    }
    return { view: 'task', id, sub: 'overview' };
  }
  if (parts[0] === 'latest' && parts[1]) return { view: 'latest', id: parts[1], path: parts.slice(2).join('/') };
  return { view: 'latest' };
}

/**
 * The tab every task's agents open in. A link given this target opens it once and loads into it after,
 * from any task, so looking at another agent takes the tab rather than adding one; `noopener` would cut
 * the tab off from this page and open a new one each time, so these links go without it.
 */
export const AGENT_TAB = 'yan-agent';

export const link = {
  task: (id: string): string => `#/t/${id}`,
  log: (id: string): string => `#/t/${id}/log`,
  report: (id: string): string => `#/t/${id}/report`,
  agent: (id: string): string => `#/t/${id}/agent`,
  file: (id: string, p: string): string => `#/t/${id}/a/${enc(p)}`,
  folder: (id: string, p: string): string => `#/t/${id}/a/${p ? enc(p) + '/' : ''}`,
  branch: (id: string, repo: number, tab?: BranchTab, item?: string, name?: string | null): string =>
    `#/t/${id}/b/${repo}${name ? '/' + encodeURIComponent(name) : ''}/${tab || 'changes'}${item ? '/' + enc(item) : ''}`,
  latest: (id?: string, p?: string): string => (id ? `#/latest/${id}/${enc(p ?? '')}` : '#/latest'),
};

/** A link inside the branch being looked at. */
export const inBranch = (r: BranchRoute, tab: BranchTab, item?: string): string => link.branch(r.id, r.repo, tab, item, r.name);

/**
 * Which view the right pane shows, apart from what changes inside it: the
 * pane keeps its view, and so its scroll, while this stays the same.
 */
export function viewKey(r: Route): string {
  if (r.view === 'latest') return `latest|${r.id ?? ''}|${r.path ?? ''}`;
  if (r.sub === 'file' || r.sub === 'folder') return `${r.id}|${r.sub}|${r.path}`;
  if (r.sub === 'branch') return `${r.id}|branch|${r.repo}|${r.name ?? ''}|${r.tab}|${r.item}`;
  return `${r.id}|${r.sub}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** The hash as it is now, redrawing whatever reads it when it moves. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}

export function useRoute(): Route {
  const hash = useHash();
  return useMemo(() => parseRoute(hash), [hash]);
}

export function go(hash: string): void {
  location.hash = hash;
}
