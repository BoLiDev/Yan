import type { ReactNode } from 'react';
import type { TaskSummary } from '../lib/api';
import type { BranchRoute } from '../lib/route';
import { Empty } from '../components/page';
import { useBranch } from '../state/server';
import { BranchFile } from './branch/BranchFile';
import { ChangesView } from './branch/ChangesView';
import { CommitView } from './branch/CommitView';
import { useKeyNav } from './nav';

/** A task's branch on the right: a file's changes, a commit, or a file as the branch has it. */
export function BranchView({ t, r }: { t: TaskSummary; r: BranchRoute }) {
  const { data: b } = useBranch(t.id, r.repo, r.name);
  if (!b) return <NoNav><Empty title="Reading the branch…" /></NoNav>;
  if (b.missing) return <NoNav><Empty title="Nothing to show">{b.missing}</Empty></NoNav>;
  if (r.tab === 'commits') return <CommitView t={t} r={r} b={b} />;
  if (r.tab === 'files') return <BranchFile t={t} r={r} b={b} />;
  return <ChangesView t={t} r={r} b={b} />;
}

function NoNav({ children }: { children: ReactNode }) {
  useKeyNav(null, null);
  return <>{children}</>;
}
