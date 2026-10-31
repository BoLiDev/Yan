// What the page's component tests share: serve stood in for at fetch, the
// stores put back between tests, and the page's own parts drawn with the
// query client they read from. Nothing here is imported by the page itself,
// so none of it is built into dist/web/.

import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-react';
import type { Index, Status, TaskDetail, TaskSummary } from '../lib/api';
import { initSeen } from '../lib/seen';
import { queryClient } from '../state/server';
import { useUI } from '../state/ui';
// Drawn with the page's own styles, so what is on top and what can be clicked is as on the page.
import '../index.css';
import '../app.css';

/** A request the page made, as serve would have seen it. */
export interface Asked {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

type Answer = Response | ((asked: Asked) => Response | Promise<Response>);

/**
 * serve, as the page's requests find it: `METHOD /path` or `/path` (any
 * method) answered by `routes`, anything else 404. Every request is kept,
 * newest last.
 */
export function serve(routes: Readonly<Record<string, Answer>>): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const one: Asked = { method, path: url.pathname, query: url.searchParams, body: raw === undefined ? undefined : JSON.parse(raw) };
    asked.push(one);
    const answer = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
    if (answer === undefined) return new Response('not found', { status: 404 });
    return typeof answer === 'function' ? answer(one) : answer.clone();
  });
  return asked;
}

export const status = (version = 1): Status => ({ version, commit: 'c1', checkedAt: 1, pulledAt: 1, ok: true, error: null, everyS: 30, local: false, build: 'b1' });

export function task(id: string, title: string, more: Partial<TaskSummary> = {}): TaskSummary {
  return { id, title, state: 'open', createdAt: null, closedAt: null, repos: [], deliverables: { done: 0, todo: 0, abandoned: 0 }, agents: [], artifacts: 0, added: [], touched: 0, rev: id, ...more };
}

export function detail(id: string, more: Partial<TaskDetail> = {}): TaskDetail {
  return { id, title: id, state: 'open', createdAt: null, closedAt: null, reason: null, repos: [], deliverables: [], resources: [], resourceKinds: {}, problem: null, log: null, files: [], hidden: [], ...more };
}

export function index(tasks: readonly TaskSummary[], more: Partial<Index> = {}): Index {
  return { tasks, latest: [], status: status(), vault: { name: 'fixture', dir: '/vault', fileLink: null, source: { include: [], exclude: [] } }, filesOrigin: 'http://localhost:1', ...more };
}

/** The vault as the page has it already: its index and the tasks given, with marks starting from it. */
export function have(ix: Index, details: readonly TaskDetail[] = []): void {
  queryClient.setQueryData(['index'], ix);
  for (const d of details) queryClient.setQueryData(['task', d.id], d);
  useUI.setState({ seen: initSeen(ix, null), status: ix.status, connected: true });
}

const fresh = useUI.getState();

/** Back to a page just opened: nothing drawn, no data, no state of its own, no stand-ins, at #/latest. */
export async function reset(): Promise<void> {
  await cleanup();
  // What was still being asked for is let go of quietly: nobody is waiting for it any more.
  await queryClient.cancelQueries(undefined, { silent: true });
  vi.unstubAllGlobals();
  queryClient.clear();
  useUI.setState(fresh, true);
  history.replaceState(null, '', '#/latest');
}

const Page = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

/** One of the page's parts, drawn as the page draws it; drawn again, it keeps the same surroundings. */
export function draw(ui: ReactNode) {
  return render(ui, { wrapper: Page });
}
