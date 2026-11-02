import { Fragment, useMemo, useState } from 'react';
import { postJSON, type TaskSummary } from '../lib/api';
import { plural } from '../lib/format';
import { go, link } from '../lib/route';
import { goesOn } from '../lib/stops';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/page';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { queryClient, useBranches } from '../state/server';
import { toast } from '../state/ui';
import { showTab } from './terminal/TabBar';
import { useKeyNav, usePick } from './nav';
import { CopyTool, PickCard, PickHeading, PickList } from './PickCard';

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
 * The task's worktrees on this machine opened in its terminal's Worktree
 * tab, a shell in each side by side, or that tab, when it is open already,
 * shown; one button for them all, as the tab is one for them all. One serve
 * cannot open says why.
 */
function OpenWorktree({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const open = async (): Promise<void> => {
    setBusy(true);
    try {
      await postJSON('/api/worktree', { task: id });
      showTab(id, 'worktree');
      await queryClient.invalidateQueries({ queryKey: ['worktrees'] });
      go(link.terminal(id));
    } catch (err) {
      toast(`Could not open the worktrees: ${(err as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" size="sm" disabled={busy} aria-busy={busy} title="Open a shell in each of the task's worktrees, in its terminal's Worktree tab" onClick={() => void open()}>
      {busy ? <Spinner aria-hidden /> : <Icon name="terminal" size={14} />}Open worktree
    </Button>
  );
}

/**
 * What the MR row holds: every branch the task kept, under its repository,
 * each saying where it stands, a merged one with the pull request it came
 * in by. One is picked, the first to start; ↑ and ↓ pick another, and Enter
 * opens it as a click does, showing its changes. On hover, a card's copy
 * tool copies the branch's name without opening it.
 */
export function MrView({ t }: { t: TaskSummary }) {
  useKeyNav(null, null);
  const branches = useListed(t);
  const { at, pick, list } = usePick(branches.length, (i) => {
    const b = branches[i];
    if (b) location.hash = b.href;
  });
  if (!branches.length) return <Empty title="No MR">{`${t.id} keeps no branch.`}</Empty>;
  return (
    <>
      <Bar title="MR" meta={plural(branches.length, 'branch', 'branches')} tools={goesOn(t) ? <OpenWorktree id={t.id} /> : null} />
      <PickList list={list}>
        {branches.map((b, i) => (
          <Fragment key={`${b.repo}:${b.name}`}>
            {b.repo !== branches[i - 1]?.repo ? <PickHeading>{b.repo}</PickHeading> : null}
            <PickCard icon={<Icon name="branch" size={18} />} name={b.name} where={b.said} mono picked={i === at} hint={i === at} onPick={() => pick(i)}
              href={b.href} title={b.name} tools={<CopyTool text={b.name} what={`the branch ${b.name}`} />} />
          </Fragment>
        ))}
      </PickList>
    </>
  );
}
