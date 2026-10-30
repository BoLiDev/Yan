import type { TaskDetail, TaskSummary } from '../lib/api';
import { plural } from '../lib/format';
import { KIND_WORD, isLink, listResources } from '../lib/resources';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/ui';
import { useKeyNav, usePick } from './nav';

/**
 * A task's resources, as Tab comes to them: under their kinds, one picked,
 * the first to start; ↑ and ↓ pick another, and Enter opens the picked one
 * in a tab of its own, as a click on any does.
 */
export function ResourcesView({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  const listed = listResources(t, d);
  const { at, pick, list } = usePick(listed.length, (i) => {
    const r = listed[i];
    if (r && isLink(r.where)) window.open(r.where.trim(), '_blank', 'noopener');
  });
  if (!listed.length) return <Empty title="No resources">{`${t.id} refers to nothing yet.`}</Empty>;
  return (
    <>
      <Bar title="Resources" meta={plural(listed.length, 'resource')} />
      <div className="scroll">
        <div className="agent-page" ref={list}>
          {listed.map((r, i) => {
            const url = isLink(r.where);
            return (
              <div key={r.name} style={{ display: 'contents' }}>
                {r.kind !== listed[i - 1]?.kind ? <div className="res-page-kind">{KIND_WORD[r.kind]}</div> : null}
                <a className={'agent-card' + (i === at ? ' picked' : '')} aria-selected={i === at} href={url ? r.where.trim() : undefined} target="_blank" rel="noopener" title={r.where} onMouseMove={() => pick(i)}>
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
