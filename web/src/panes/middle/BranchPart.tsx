import { useEffect, type ReactNode } from 'react';
import type { TaskSummary } from '../../lib/api';
import { buildTree, changeOrder, foldersAbove } from '../../lib/files';
import { inBranch, type BranchRoute } from '../../lib/route';
import { isSource, sourceView } from '../../lib/source';
import { SUBLABEL, Seg } from '../../components/page';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { useBranch, useBranchTree, useIndex } from '../../state/server';
import { setPref, toggled, useUI } from '../../state/ui';
import { TreeRows } from '../Tree';
import { Commits, Counts, StatusLetter } from './Changes';
import { revealOnce, setFolder } from './folds';

/** The branch part of a task's column: its changes, its commits or its files. */
export function useBranchPart(t: TaskSummary, r: BranchRoute): { top: ReactNode; body: ReactNode } {
  const repo = t.repos[r.repo];
  const { data: b } = useBranch(t.id, r.repo, r.name, !!repo?.branch);
  const filesKey = `${t.id}:${r.repo}:${r.name ?? ''}:files`;
  const changesKey = `${t.id}:${r.repo}:${r.name ?? ''}:changes`;
  const tree = useBranchTree(t.id, r.repo, b?.head, r.tab === 'files' && !!b && !b.missing);
  const filesOpen = useUI((s) => s.open[filesKey]);
  const closed = useUI((s) => s.closed[changesKey]);
  const sourceOnly = useUI((s) => !s.prefs.allFiles);
  const rules = useIndex().data?.vault.source;
  // With source code alone, the branch is the one its tree and prev and next show.
  const shown = b && !b.missing && sourceOnly && rules ? sourceView(b, rules) : b;
  const cur = b && !b.missing && shown ? r.item || changeOrder(shown)[0]?.path : undefined;

  // The folders of what is asked for open once, and can be closed after.
  useEffect(() => {
    if (r.tab === 'files' && r.item && revealOnce(filesKey, r.item)) {
      useUI.setState((s) => ({ open: { ...s.open, [filesKey]: [...new Set([...(s.open[filesKey] ?? []), ...foldersAbove(r.item)])] } }));
    }
    if (r.tab === 'changes' && cur && revealOnce(changesKey, cur)) {
      const above = new Set(foldersAbove(cur));
      useUI.setState((s) => ({ closed: { ...s.closed, [changesKey]: (s.closed[changesKey] ?? []).filter((p) => !above.has(p)) } }));
    }
  }, [r.tab, r.item, cur, filesKey, changesKey]);

  if (!repo?.branch) return { top: <div className={SUBLABEL}>This task keeps no branch here.</div>, body: null };
  // The nav's row says which branch this is and where it stands; what is below is what it changed.
  if (!b) return { top: <div className={SUBLABEL}>Reading the branch…</div>, body: null };
  if (b.missing) return { top: <div className={cn(SUBLABEL, 'text-destructive')}>{b.missing}</div>, body: null };

  const files = (shown ?? b).files;
  const tabs = <Seg wide options={[['changes', `Changes ${files.length}`], ['commits', `Commits ${b.commits.length}`], ['files', 'All files']] as const} current={r.tab} onPick={(tab) => { location.hash = inBranch(r, tab); }} />;
  const sourceCount = rules ? b.files.filter((f) => isSource(rules, f.path)).length : b.files.length;
  // Over the changes and the files alike; the commits are what they are.
  const switcher = r.tab === 'commits' ? null : (
    <label className={cn('mx-0.5 flex cursor-pointer items-center gap-2.5 rounded-lg bg-hover px-2.5 py-1.5 text-[13px] select-none', sourceOnly ? 'text-foreground' : 'text-ink-2')}>
      <span className="min-w-0 flex-1 truncate">Source code only</span>
      <span className="text-xs text-ink-3 tabular-nums">{`${sourceCount} / ${b.files.length}`}</span>
      <Switch checked={sourceOnly} onCheckedChange={(on) => setPref('allFiles', !on)} className="data-checked:bg-brand" />
    </label>
  );
  let list: ReactNode;
  if (r.tab === 'commits') {
    list = <Commits r={r} commits={b.commits} />;
  } else if (r.tab === 'files') {
    const open = filesOpen ?? [];
    list = !tree.data ? <div className={SUBLABEL}>reading the files…</div> : (
      <TreeRows node={buildTree(sourceOnly && rules ? tree.data.filter((f) => isSource(rules, f.path)) : tree.data)} options={{
        isOpen: (p) => open.includes(p),
        setOpen: (p, on) => setFolder(filesKey, open, p, on),
        file: r.item || null,
        folder: null,
        thumbs: false,
        compact: true,
        step: 12,
        fileHref: (p) => inBranch(r, 'files', p),
      }} />
    );
  } else {
    // Every folder starts open; one closed by hand stays closed until a file in it is asked for.
    const shut = closed ?? [];
    list = (
      <>
        <TreeRows node={buildTree(files)} options={{
          isOpen: (p) => !shut.includes(p),
          setOpen: (p, on) => useUI.setState((s) => ({ closed: { ...s.closed, [changesKey]: toggled(s.closed[changesKey], p, !on) } })),
          file: cur ?? null,
          folder: null,
          compact: true,
          step: 12,
          fileHref: (p) => inBranch(r, 'changes', p),
          tip: (f) => (f.from ? `${f.from} → ${f.path}` : f.path),
          lead: (f) => <StatusLetter status={f.status} />,
          extra: (f) => <Counts add={f.add} del={f.del} />,
        }} />
        {!b.files.length ? <div className={SUBLABEL}>{`No changes against ${b.target}.`}</div> : null}
        {b.files.length && !files.length ? <div className={SUBLABEL}>No source code among the changes.</div> : null}
      </>
    );
  }
  return { top: <div className="flex flex-col gap-2">{tabs}{switcher}</div>, body: <div className="flex flex-col gap-px" role="tree">{list}</div> };
}
