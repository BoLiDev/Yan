import { useEffectEvent, useLayoutEffect, useRef } from 'react';
import { postJSON, type DeliverableStatus, type TaskDetail, type TaskSummary, type WriteResult } from '../lib/api';
import { Empty } from '../components/page';
import { fileUrl, onStatus, queryClient, useReport, vaultPath } from '../state/server';
import { toast, useUI } from '../state/ui';
import { useKeyNav } from './nav';
import { buildIsland, type Island } from './reportIsland';

/** How long a word said on a report outlives the redraw its change causes. */
const SAID_FOR_MS = 5000;

/**
 * A task's report, with checking, giving up and editing on top of it. The
 * report is built in its shadow root once for each report.html; after that
 * it is only told what moved, so a push never takes the reader back to the top.
 */
export function ReportView({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  const rep = useReport(t.id);
  const host = useRef<HTMLDivElement>(null);
  const island = useRef<Island | null>(null);

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
      copied: (url) => void navigator.clipboard.writeText(url).then(() => toast('Link copied')),
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

  if (rep.isError && !rep.data) return <Empty title="No report">{String(rep.error.message)}</Empty>;
  if (!rep.data) return <Empty>Loading…</Empty>;
  return <div className="scroll" style={{ background: '#000' }}><div className="report-host" ref={host} data-task={t.id} /></div>;
}
