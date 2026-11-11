import { useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { postJSON, type DeliverableStatus, type TaskDetail, type TaskSummary, type WriteResult } from '../lib/api';
import { useHash } from '../lib/route';
import { Empty, Scroll } from '../components/page';
import { PickMenu, type PickMenuApi } from '../components/review/PickMenu';
import { ContextMenuItem } from '../components/ui/context-menu';
import { useComments, useReview } from '../state/review';
import { fileUrl, onStatus, queryClient, useReport, vaultPath } from '../state/server';
import { copyText, message, useUI } from '../state/ui';
import { useKeyNav } from './nav';
import { buildIsland, type Island } from './reportIsland';
import type { ReportPick } from './reportReview';

/** How long a word said on a report outlives the redraw its change causes. */
const SAID_FOR_MS = 5000;

/**
 * A task's report, with checking, giving up and editing on top of it. The
 * report is built in its shadow root once for each report.html; after that
 * it is only told what moved, so a push never takes the reader back to the top.
 * Words selected in it, and its pictures, are commented on from a right
 * click, into the task's review, as anything else read on the page is.
 */
export function ReportView({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  const rep = useReport(t.id);
  const host = useRef<HTMLDivElement>(null);
  const island = useRef<Island | null>(null);
  const menu = useRef<PickMenuApi>(null);
  const [picked, setPicked] = useState<ReportPick | null>(null);
  const picking = useEffectEvent((p: ReportPick): void => {
    setPicked(p);
    menu.current?.open(p.x, p.y);
  });

  // What the island, built once, calls later: these read the task as it is when they are called.
  const say = useEffectEvent((text: string, bad: boolean): void => {
    useUI.setState((s) => ({ said: { ...s.said, [t.id]: { text, bad, at: Date.now() } } }));
    island.current?.say(text, bad);
  });
  const wrote = useEffectEvent((out: WriteResult, ok: string, pushed: string): void => {
    say(out.warning ? `${pushed}: ${out.warning}` : ok, !!out.warning);
    void onStatus(out.status);
  });

  const html = rep.data?.html;
  const sha = rep.data?.sha;
  // The island built again for a new report.html only; the facts and the deliverables are told below.
  const build = useEffectEvent(() => {
    const el = host.current;
    const report = rep.data;
    if (!el || !report) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const said = useUI.getState().said[t.id];
    island.current = buildIsland(root, report, d.deliverables, {
      send: (id: string, to: DeliverableStatus, reason?: string) => {
        postJSON<WriteResult>('/api/deliverable', { task: t.id, id, to, reason }).then(
          (out) => wrote(out, `Saved ${t.id}'s deliverables`, 'Saved, but the push failed'),
          (err: Error) => {
            say(`Not saved: ${err.message}`, true);
            void queryClient.invalidateQueries({ queryKey: ['task', t.id] });
          },
        );
      },
      reason: (id, reason) => {
        postJSON<WriteResult>('/api/deliverable', { task: t.id, id, to: 'abandoned', reason }).then(
          (out) => wrote(out, `Saved why ${id} was given up`, 'Saved, but the push failed'),
          (err: Error) => say(`Not saved: ${err.message}`, true),
        );
      },
      edit: (index, text) => {
        postJSON<WriteResult>('/api/report/edit', { task: t.id, sha: report.sha, index, text }).then(
          (out) => wrote(out, 'Saved to report.html', 'Saved, but the push failed'),
          (err: Error) => say(`Not saved: ${err.message}`, true),
        );
      },
      copied: (url) => void navigator.clipboard.writeText(url).then(() => message.success('Link copied')),
      pick: picking,
      uatUrl: (path) => fileUrl(vaultPath(t.id, `uat/${path}`)),
      downloadUrl: `/api/report/download?task=${encodeURIComponent(t.id)}`,
    }, said && Date.now() - said.at < SAID_FOR_MS ? said : null);
  });
  useLayoutEffect(() => build(), [t.id, html, sha]);

  useLayoutEffect(() => {
    if (rep.data) island.current?.setFacts(rep.data);
  }, [rep.data]);
  useLayoutEffect(() => {
    island.current?.setDeliverables(d.deliverables);
  }, [d.deliverables]);

  // What has been commented on here is marked, and again once the report is built anew.
  const hash = useHash();
  const all = useComments(t.id);
  const exacts = useMemo(() => all.filter((c) => c.href === hash && c.exact !== '').map((c) => c.exact), [all, hash]);
  useLayoutEffect(() => {
    island.current?.mark(exacts);
    return () => island.current?.mark([]);
  }, [exacts, html, sha]);

  if (rep.isError && !rep.data) return <Empty title="No report">{String(rep.error.message)}</Empty>;
  if (!rep.data) return <Empty>Loading…</Empty>;
  return (
    <Scroll className="bg-black">
      <PickMenu api={menu} menu={
        <>
          <ContextMenuItem onClick={() => {
            if (picked) useReview.setState({ drafting: { task: t.id, where: picked.where, quote: picked.quote, exact: picked.exact, href: location.hash } });
          }}>Comment</ContextMenuItem>
          {picked?.quote ? <ContextMenuItem onClick={() => copyText(picked.quote, 'Copied', 'Copy what was picked')}>Copy</ContextMenuItem> : null}
        </>
      }>
        <div ref={host} data-task={t.id} />
      </PickMenu>
    </Scroll>
  );
}
