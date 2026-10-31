import { QueryClient, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ApiError, getJSON, getText, postJSON, type BranchBlob, type BranchView, type CommitPatch, type Index, type Report, type Status, type TaskDetail, type TerminalState, type WriteResult } from '../lib/api';
import { enc } from '../lib/files';
import { langLoaded, langReady } from '../lib/highlight';
import { parseRoute } from '../lib/route';
import { initSeen } from '../lib/seen';
import { tellOfPushes } from './notify';
import { storedSeen, toast, useUI } from './ui';

/**
 * What the server sends, held by TanStack Query, one query per thing the page
 * shows: the index, each task, each branch, each text. Nothing is fetched
 * again on its own (`staleTime: Infinity`); the server says when the vault
 * moved, through /api/events, and only what moved is fetched again: the
 * index, then each task whose files changed. A query fetched again with the
 * same answer keeps the same objects, so nothing that shows it redraws.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: Infinity, gcTime: 10 * 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1 },
  },
});

async function fetchIndex(): Promise<Index> {
  const index = await getJSON<Index>('/api/index');
  if (!useUI.getState().seen) useUI.setState({ seen: initSeen(index, storedSeen) });
  useUI.setState({ status: index.status, connected: true });
  tellOfPushes(index);
  return index;
}

export const useIndex = (): UseQueryResult<Index> => useQuery({ queryKey: ['index'], queryFn: fetchIndex });

/**
 * The tasks whose agent runs in a herdr pane here, with what herdr says of
 * each. Not the vault's, so no event says it moved: it is asked every two
 * seconds instead.
 */
export const useTerminals = (): UseQueryResult<Readonly<Record<string, TerminalState>>> =>
  useQuery({ queryKey: ['terminals'], queryFn: () => getJSON<Record<string, TerminalState>>('/api/terminals'), staleTime: 0, refetchInterval: 2000, retry: false });

export function useTask(id: string | undefined): UseQueryResult<TaskDetail> {
  return useQuery({ queryKey: ['task', id], queryFn: () => getJSON<TaskDetail>(`/api/task/${encodeURIComponent(id as string)}`), enabled: !!id });
}

export function useReport(id: string): UseQueryResult<Report> {
  return useQuery({ queryKey: ['report', id], queryFn: () => getJSON<Report>(`/api/report?task=${encodeURIComponent(id)}`) });
}

const branchUrl = (id: string, repo: number, name: string | null, fresh = false): string =>
  `/api/branch?task=${encodeURIComponent(id)}&repo=${repo}${name ? `&branch=${encodeURIComponent(name)}` : ''}${fresh ? '&fresh=1' : ''}`;

/** A task's branch: the one its tree was last on under no name, another of its own by name. */
export function useBranch(id: string, repo: number, name: string | null, enabled = true): UseQueryResult<BranchView> {
  return useQuery({ queryKey: ['branch', id, repo, name ?? ''], queryFn: () => getJSON<BranchView>(branchUrl(id, repo, name)), enabled });
}

/**
 * Every branch a task kept in a repository, for what the nav says of each:
 * merged or not. Asked for once `enabled`, after the task itself: each is
 * git's work on the server, and the task's details would wait behind them.
 */
export function useBranches(id: string, wanted: readonly { readonly repo: number; readonly name: string | null }[], enabled = true): (BranchView | undefined)[] {
  return useQueries({
    queries: wanted.map(({ repo, name }) => ({ queryKey: ['branch', id, repo, name ?? ''], queryFn: () => getJSON<BranchView>(branchUrl(id, repo, name)), enabled })),
  }).map((q) => q.data);
}

export function useBranchTree(id: string, repo: number, head: string | undefined, enabled = true): UseQueryResult<BranchBlob[]> {
  return useQuery({
    queryKey: ['branchTree', id, repo, head],
    queryFn: () => getJSON<BranchBlob[]>(`/api/branch/tree?task=${encodeURIComponent(id)}&repo=${repo}&head=${head}`),
    enabled: enabled && !!head,
  });
}

export function useCommit(id: string, repo: number, sha: string | undefined): UseQueryResult<CommitPatch> {
  return useQuery({
    queryKey: ['commit', id, repo, sha],
    queryFn: () => getJSON<CommitPatch>(`/api/branch/commit?task=${encodeURIComponent(id)}&repo=${repo}&sha=${sha}`),
    enabled: !!sha,
  });
}

/** A text once per URL: a blob or a diff named by its shas is the same bytes forever. */
export function useText(url: string | null): UseQueryResult<string> {
  return useQuery({ queryKey: ['text', url], queryFn: () => getText(url as string), enabled: !!url });
}

/** Whether highlight.js can colour `lang` yet, loading it the first time it is asked for. */
export function useLang(lang: string | null): boolean {
  const q = useQuery({ queryKey: ['lang', lang], queryFn: () => langReady(lang).then(() => true), enabled: !langLoaded(lang) });
  return langLoaded(lang) || q.data === true;
}

/** Whether highlight.js can colour every one of `langs` yet. */
export function useLangs(langs: readonly (string | null)[]): boolean {
  const wanted = [...new Set(langs.filter((l): l is string => !!l && !langLoaded(l)))];
  const qs = useQueries({ queries: wanted.map((lang) => ({ queryKey: ['lang', lang], queryFn: () => langReady(lang).then(() => true) })) });
  return qs.every((q) => q.data === true);
}

/** The vault's files are served one port up, where a page an agent wrote runs as itself. */
export function filesOrigin(): string {
  return queryClient.getQueryData<Index>(['index'])?.filesOrigin ?? '';
}
export const vaultPath = (id: string, rel: string): string => `tasks/${id}/artifacts/${rel}`;
export const fileUrl = (path: string): string => `${filesOrigin()}/${enc(path)}`;
export const shaUrl = (sha: string, name: string): string => `${filesOrigin()}/_sha/${sha}/${encodeURIComponent(name)}`;
/**
 * A picture shown small, at a small copy the server makes of it: a row's,
 * or a card's in a folder's grid. A whole screenshot behind each of them is
 * more than Chrome keeps decoded, and every redraw then waits for it. An SVG
 * is drawn at any size for nothing, so it is itself.
 */
export const thumbUrl = (sha: string, name: string, size: 'row' | 'card'): string =>
  (/\.svg$/i.test(name) ? shaUrl(sha, name) : `${filesOrigin()}/_thumb/${size}/${sha}/${encodeURIComponent(name)}`);

// ── keeping up with the vault ──────────────────────────────────────────────

let build: string | null = null;
let refreshing: Promise<void> | null = null;

/** The index again, and every task whose files changed since the last one. */
async function refreshIndex(): Promise<void> {
  const before = queryClient.getQueryData<Index>(['index']);
  const next = await queryClient.fetchQuery({ queryKey: ['index'], queryFn: fetchIndex, staleTime: 0 });
  const was = new Map(before?.tasks.map((t) => [t.id, t.rev]));
  for (const t of next.tasks) {
    if (was.get(t.id) === t.rev) continue;
    void queryClient.invalidateQueries({ queryKey: ['task', t.id] });
    void queryClient.invalidateQueries({ queryKey: ['report', t.id] });
  }
}

/**
 * What the server says on every tick, and after every change made from the
 * page. A yan serve that restarted on a newer yan means this page is the old
 * one, so it loads the new.
 */
export async function onStatus(st: Status): Promise<void> {
  if (st.build && build && st.build !== build) {
    location.reload();
    return;
  }
  if (st.build) build = st.build;
  useUI.setState({ status: st, connected: true });
  const have = queryClient.getQueryData<Index>(['index']);
  if (!have || st.version !== have.status.version) {
    refreshing ??= refreshIndex().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  // The branch being looked at is fetched again each tick: the server fetches it from origin when it is stale.
  const r = parseRoute(location.hash);
  if (r.view === 'task' && r.sub === 'branch') void queryClient.invalidateQueries({ queryKey: ['branch', r.id, r.repo, r.name ?? ''] });
  return undefined;
}

/** Listen to the server for as long as the page is open; returns how to stop. */
export function connect(): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => {
    const wasDown = !useUI.getState().connected;
    // Back after being away: anything may have moved meanwhile.
    if (wasDown) void queryClient.invalidateQueries();
    void onStatus(JSON.parse((e as MessageEvent<string>).data) as Status);
  });
  es.onerror = () => useUI.setState({ connected: false });
  return () => es.close();
}

/**
 * A pull now, by hand: it fetches the branch being looked at too, and waits
 * for it. Only serve not answering says it stopped; a branch it cannot read
 * is the branch view's to say, as it says it on any other tick.
 */
export async function pullNow(): Promise<void> {
  if (useUI.getState().pulling) return;
  useUI.setState({ pulling: true });
  try {
    await onStatus(await postJSON<Status>('/api/pull', {}));
    const at = parseRoute(location.hash);
    if (at.view === 'task' && at.sub === 'branch') {
      queryClient.setQueryData(['branch', at.id, at.repo, at.name ?? ''], await getJSON<BranchView>(branchUrl(at.id, at.repo, at.name, true)));
    }
  } catch (err) {
    if (!(err instanceof ApiError)) useUI.setState({ connected: false });
  } finally {
    useUI.setState({ pulling: false });
  }
}

/** One change to a task's files from the page, said in a toast; the page shows it once the vault has it. */
export function writeTask(url: string, value: { readonly task: string } & Record<string, unknown>, said: string): Promise<void> {
  return postJSON<WriteResult>(url, value).then((out) => {
    toast(out.warning ? `${said}, but the push failed: ${out.warning}` : said);
    void onStatus(out.status);
  }, (err: Error) => {
    toast(`Not saved: ${err.message}`);
    void queryClient.invalidateQueries({ queryKey: ['task', value.task] });
  });
}
