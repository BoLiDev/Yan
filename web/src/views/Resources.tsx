import { Fragment } from 'react';
import type { TaskDetail, TaskSummary } from '../lib/api';
import { plural } from '../lib/format';
import { KIND_WORD, isLink, listResources } from '../lib/resources';
import { Bar, Empty } from '../components/page';
import { useKeyNav, usePick } from './nav';
import { PickHeading, PickList } from './PickCard';
import { ResourceCard } from './ResourceCard';

/**
 * A task's resources, its agents and its merge requests aside, which have
 * pages of their own: under their kinds, one picked, the first to start;
 * ↑ and ↓ pick another, and Enter opens the picked one in a tab of its own,
 * as a click on any does. On hover, a card's pencil edits where it points
 * and its bin forgets it.
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
        {listed.map((r, i) => (
          <Fragment key={r.name}>
            {r.kind !== listed[i - 1]?.kind ? <PickHeading>{KIND_WORD[r.kind]}</PickHeading> : null}
            <ResourceCard task={t.id} r={r} picked={i === at} onPick={() => pick(i)} />
          </Fragment>
        ))}
      </PickList>
    </>
  );
}
