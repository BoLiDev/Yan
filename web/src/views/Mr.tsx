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

/** A branch as the page lists it: the repository it is in, by name and by place, where it opens, where it stands, and the pull request a merged one came in by. */
interface Listed {
  readonly repo: string;
  readonly at: number;
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
      at: i,
      name: b.name,
      href: b.name === repo.branch ? link.branch(t.id, i) : link.branch(t.id, i, 'changes', '', b.name),
      said: b.view?.merged?.pr ? `${BRANCH_SAID.merged} · PR #${b.view.merged.pr}` : BRANCH_SAID[state],
    })));
  });
}

/**
 * A branch card's tool that opens the worktree of its repository, the one
 * tree the task has of it here, in a tab of the task's terminal, and shows
 * it: every branch of a repository is worked on in that tree, so they all
 * open the same tab, and each other repository's opens a tab of its own.
 * One serve cannot open says why. Clicked, it gives the keys back to the
 * page, as the copy tool does.
 */
function OpenWorktree({ id, repo, name }: { id: string; repo: number; name: string }) {
  const [busy, setBusy] = useState(false);
  const open = async (): Promise<void> => {
    setBusy(true);
    try {
      const { tab } = await postJSON<{ tab: string }>('/api/worktree', { task: id, repo });
      showTab(id, tab);
      await queryClient.invalidateQueries({ queryKey: ['worktrees'] });
      go(link.terminal(id));
    } catch (err) {
      toast(`Could not open the worktree of ${name}: ${(err as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  };
  const label = `Open the worktree of ${name}`;
  return (
    <Button variant="ghost" size="icon-xs" className="text-ink-3" title={label} aria-label={label} disabled={busy} aria-busy={busy}
      onClick={(e) => { e.currentTarget.blur(); void open(); }}>
      {busy ? <Spinner aria-hidden /> : <Icon name="folder" size={14} />}
    </Button>
  );
}

/**
 * What the MR row holds: every branch the task kept, under its repository,
 * each saying where it stands, a merged one with the pull request it came
 * in by. One is picked, the first to start; ↑ and ↓ pick another, and Enter
 * opens it as a click does, showing its changes. On hover, a card's tools
 * open its repository's worktree in a tab of the task's terminal, and copy
 * the branch's name, neither opening the branch.
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
      <Bar title="MR" meta={plural(branches.length, 'branch', 'branches')} />
      <PickList list={list}>
        {branches.map((b, i) => (
          <Fragment key={`${b.repo}:${b.name}`}>
            {b.repo !== branches[i - 1]?.repo ? <PickHeading>{b.repo}</PickHeading> : null}
            <PickCard icon={<Icon name="branch" size={18} />} name={b.name} where={b.said} mono picked={i === at} hint={i === at} onPick={() => pick(i)}
              href={b.href} title={b.name} tools={<>
                {goesOn(t) ? <OpenWorktree id={t.id} repo={b.at} name={b.repo} /> : null}
                <CopyTool text={b.name} what={`the branch ${b.name}`} />
              </>} />
          </Fragment>
        ))}
      </PickList>
    </>
  );
}
