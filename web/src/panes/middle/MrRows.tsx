import { useMemo, type ReactNode } from 'react';
import type { TaskSummary } from '../../lib/api';
import { link, type Route } from '../../lib/route';
import { ASIDE, GROW } from '../../components/page';
import { cn } from '../../lib/utils';
import { useBranches } from '../../state/server';
import { copyText, useUI } from '../../state/ui';
import { FoldRow, StepRow } from './FoldRow';
import { flip } from './folds';
import { underRow } from './look';

/** How the nav says where a branch stands. */
const BRANCH_SAID = { open: 'in progress', merged: 'merged', abandoned: 'abandoned' } as const;

/** A branch as the MR row lists it: where it stands, and the pull request a merged one came in by. */
interface Listed {
  readonly name: string;
  readonly state: keyof typeof BRANCH_SAID;
  readonly pr: number | null;
}

/**
 * The MR row: every branch the task kept, under the repository it is in,
 * folded until asked and open while one of them is shown; each repository
 * under it is open until folded by hand. Its figure counts those in progress
 * in every repository, and each repository counts its own. A task in one
 * repository has its branches straight under the row.
 */
export function MrRows({ t, r, ready }: { t: TaskSummary; r: Route; ready: boolean }) {
  const repos = useMemo(() => t.repos.flatMap((repo, i) => (repo.branch ? [{ repo, i, names: [repo.branch, ...[...repo.earlier].reverse()] }] : [])), [t.repos]);
  // The branch a tree was last on is read under no name, the others under theirs.
  const wanted = useMemo(() => repos.flatMap(({ repo, i, names }) => names.map((n) => ({ repo: i, name: n === repo.branch ? null : n }))), [repos]);
  const views = useBranches(t.id, wanted, ready);
  const unfolded = useUI((s) => s.unfolded);
  let k = 0;
  const lists = repos.map(({ repo, i, names }) => {
    const mine = names.map((name) => ({ name, view: views[k++] }));
    const stateOf = (b: (typeof mine)[number]): Listed['state'] => (b.view?.merged ? 'merged' : repo.abandoned.includes(b.name) ? 'abandoned' : 'open');
    // In progress first, the one the tree was last on leading; then merged, then abandoned, newest first in each.
    const branches = (['open', 'merged', 'abandoned'] as const).flatMap((state) => mine.filter((b) => stateOf(b) === state).map((b): Listed => ({ name: b.name, state, pr: b.view?.merged?.pr ?? null })));
    return { repo, i, branches, open: branches.filter((b) => b.state === 'open').length };
  });
  const shown = r.view === 'task' && r.sub === 'branch' ? r : null;
  const fold = `${t.id}:mr`;
  const open = unfolded[fold] ?? !!shown;
  const total = lists.reduce((n, l) => n + l.open, 0);

  const branchRow = (l: (typeof lists)[number], b: Listed, deep: boolean): ReactNode => {
    const on = !!shown && shown.repo === l.i && (shown.name || l.repo.branch) === b.name;
    // Its name is what a branch's row is wanted for most: a click copies it, and opens the branch too.
    return (
      <a key={`${l.i}:${b.name}`} className={underRow(on, deep)} aria-current={on ? 'page' : undefined}
        href={b.name === l.repo.branch ? link.branch(t.id, l.i) : link.branch(t.id, l.i, 'changes', '', b.name)}
        title={`${b.name}: click to copy`} onClick={() => copyText(b.name, 'Branch name copied', 'The branch')}>
        <span className={cn(GROW, 'font-mono text-[12px]')}>{b.name}</span>
        <span className={ASIDE}>{b.pr ? `${BRANCH_SAID.merged} PR #${b.pr}` : BRANCH_SAID[b.state]}</span>
      </a>
    );
  };
  const direct = lists.length === 1;
  return (
    <>
      <FoldRow icon="branch" word="MR" aside={total ? `${total} ${BRANCH_SAID.open}` : null} open={open} onFlip={() => flip(fold, open)} />
      {open && direct ? (lists[0] as (typeof lists)[number]).branches.map((b) => branchRow(lists[0] as (typeof lists)[number], b, false)) : null}
      {open && !direct ? lists.flatMap((l) => {
        const key = `${t.id}:mr:${l.i}`;
        // Open until folded by hand, so one click on MR shows every branch.
        const here = unfolded[key] ?? true;
        return [
          <StepRow key={key} name={l.repo.name} aside={l.open ? `${l.open} ${BRANCH_SAID.open}` : null} open={here} onFlip={() => flip(key, here)} />,
          ...(here ? l.branches.map((b) => branchRow(l, b, true)) : []),
        ];
      }) : null}
    </>
  );
}
