import { Fragment } from 'react';
import type { TaskDetail, TaskSummary } from '../lib/api';
import { plural } from '../lib/format';
import { KIND_WORD, isLink, listResources } from '../lib/resources';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/page';
import { useKeyNav, usePick } from './nav';
import { PickCard, PickList } from './PickCard';

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
      <PickList list={list}>
        {listed.map((r, i) => {
          const url = isLink(r.where);
          return (
            <Fragment key={r.name}>
              {r.kind !== listed[i - 1]?.kind ? <div className="mt-2 text-[12.5px] font-bold text-ink-3">{KIND_WORD[r.kind]}</div> : null}
              <PickCard icon={<Icon name={url ? 'link' : 'note'} size={18} />} name={r.name} where={r.where} picked={i === at} hint={url && i === at}
                href={url ? r.where.trim() : undefined} target="_blank" rel="noopener" onMouseMove={() => pick(i)} />
            </Fragment>
          );
        })}
      </PickList>
    </>
  );
}
