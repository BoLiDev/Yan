import { Fragment, useMemo, type ReactNode } from 'react';
import type { TaskDetail, TaskSummary } from '../lib/api';
import { plural } from '../lib/format';
import { isLink, mergeRequests } from '../lib/resources';
import { link } from '../lib/route';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/page';
import { useBranches } from '../state/server';
import { useKeyNav, usePick } from './nav';
import { CopyTool, PickCard, PickHeading, PickList } from './PickCard';
import { ResourceCard } from './ResourceCard';

/** How the page says where a branch stands. */
const BRANCH_SAID = { open: 'in progress', merged: 'merged', abandoned: 'abandoned' } as const;

/** A branch as the page lists it: the repository it is in, where it opens, where it stands, and the pull request a merged one came in by. */
interface Listed {
  readonly repo: string;
  readonly name: string;
  readonly href: string;
  readonly said: string;
}

/**
 * The branches of every repository the task keeps one in, in progress first,
 * the one its tree was last on leading them, then merged, then abandoned,
 * newest first in each. Whether one is merged is git's work on the server,
 * asked for once the page is open.
 */
function useListed(t: TaskSummary): Listed[] {
  const repos = useMemo(() => t.repos.flatMap((repo, i) => (repo.branch ? [{ repo, i, names: [repo.branch, ...[...repo.earlier].reverse()] }] : [])), [t.repos]);
  // The branch a tree was last on is read under no name, the others under theirs.
  const wanted = useMemo(() => repos.flatMap(({ repo, i, names }) => names.map((n) => ({ repo: i, name: n === repo.branch ? null : n }))), [repos]);
  const views = useBranches(t.id, wanted);
  let k = 0;
  return repos.flatMap(({ repo, i, names }) => {
    const mine = names.map((name) => ({ name, view: views[k++] }));
    const stateOf = (b: (typeof mine)[number]): keyof typeof BRANCH_SAID => (b.view?.merged ? 'merged' : repo.abandoned.includes(b.name) ? 'abandoned' : 'open');
    return (['open', 'merged', 'abandoned'] as const).flatMap((state) => mine.filter((b) => stateOf(b) === state).map((b): Listed => ({
      repo: repo.name,
      name: b.name,
      href: b.name === repo.branch ? link.branch(t.id, i) : link.branch(t.id, i, 'changes', '', b.name),
      said: b.view?.merged?.pr ? `${BRANCH_SAID.merged} · PR #${b.view.merged.pr}` : BRANCH_SAID[state],
    })));
  });
}

/**
 * What the MR row holds: the merge requests the task refers to, which open
 * in a tab of their own and are edited and forgotten as any resource is,
 * then every branch it kept, under its repository, each saying where it
 * stands. One is picked, the first to start; ↑ and ↓ pick another, and
 * Enter opens it as a click does, a branch showing its changes. On hover,
 * each card's copy tool copies a branch's name or a merge request's link
 * without opening it.
 */
export function MrView({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  const requests = mergeRequests(t, d);
  const branches = useListed(t);
  const { at, pick, list } = usePick(requests.length + branches.length, (i) => {
    const r = requests[i];
    if (r) {
      if (isLink(r.where)) window.open(r.where.trim(), '_blank', 'noopener');
      return;
    }
    const b = branches[i - requests.length];
    if (b) location.hash = b.href;
  });
  if (!requests.length && !branches.length) return <Empty title="No MR">{`${t.id} keeps no branch and refers to no merge request.`}</Empty>;
  const meta = [requests.length ? plural(requests.length, 'merge request') : '', branches.length ? plural(branches.length, 'branch', 'branches') : ''].filter(Boolean).join(' · ');
  const cards: ReactNode[] = [
    ...(requests.length ? [<PickHeading key="mr">Merge requests</PickHeading>] : []),
    ...requests.map((r, i) => <ResourceCard key={`mr:${r.name}`} task={t.id} r={r} picked={i === at} onPick={() => pick(i)} copy />),
    ...branches.map((b, j) => {
      const i = requests.length + j;
      return (
        <Fragment key={`${b.repo}:${b.name}`}>
          {b.repo !== branches[j - 1]?.repo ? <PickHeading>{b.repo}</PickHeading> : null}
          <PickCard icon={<Icon name="branch" size={18} />} name={b.name} where={b.said} mono picked={i === at} hint={i === at} onPick={() => pick(i)}
            href={b.href} title={b.name} tools={<CopyTool text={b.name} what={`the branch ${b.name}`} />} />
        </Fragment>
      );
    }),
  ];
  return (
    <>
      <Bar title="MR" meta={meta} />
      <PickList list={list}>{cards}</PickList>
    </>
  );
}
