import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TaskDetail, TaskSummary } from '../lib/api';
import { KIND_WORD, isLink, listResources } from '../lib/resources';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/ui';
import { useUI } from '../state/ui';
import { useKeyNav } from './nav';

/**
 * A task's resources, as Tab comes to them: under their kinds, one picked,
 * the first to start; ↑ and ↓ pick another, and Enter opens the picked one
 * in a tab of its own, as a click on any does.
 */
export function ResourcesView({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  const listed = listResources(t, d);
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLElement | null;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '') || active?.isContentEditable || useUI.getState().palette || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setAt((a) => Math.max(0, Math.min(listed.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter' && (!active || active === document.body)) {
        const r = listed[at];
        if (r && isLink(r.where)) {
          e.preventDefault();
          window.open(r.where.trim(), '_blank', 'noopener');
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  if (!listed.length) return <Empty title="No resources">{`${t.id} refers to nothing yet.`}</Empty>;
  return (
    <>
      <Bar title="Resources" meta={`${listed.length} · ↑↓ to pick, Enter opens it in a tab of its own`} />
      <div className="scroll">
        <div className="agent-page" ref={list}>
          {listed.map((r, i) => {
            const url = isLink(r.where);
            return (
              <div key={r.name} style={{ display: 'contents' }}>
                {r.kind !== listed[i - 1]?.kind ? <div className="res-page-kind">{KIND_WORD[r.kind]}</div> : null}
                <a className={'agent-card' + (i === at ? ' picked' : '')} aria-selected={i === at} href={url ? r.where.trim() : undefined} target="_blank" rel="noopener" title={r.where} onMouseMove={() => setAt(i)}>
                  <Icon name={url ? 'link' : 'note'} size={18} />
                  <span className="grow"><b>{r.name}</b><span className="where">{r.where}</span></span>
                  {url && i === at ? <span className="button">打开<kbd>↵</kbd></span> : null}
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
