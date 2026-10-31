import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import type { Index, TaskDetail, TaskSummary } from '../lib/api';
import { badge, baseName, buildTree, changeOrder, dirName, foldersAbove } from '../lib/files';
import { AGENT_WORD, clock, dayLabel, dayOf, plural, short } from '../lib/format';
import { AGENT_TAB, inBranch, link, useHash, useRoute, type BranchRoute, type Route, type TaskRoute } from '../lib/route';
import { KIND_WORD, isLink, listResources, type Listed as Resource } from '../lib/resources';
import { isSource, sourceView } from '../lib/source';
import { dropped as dropTo, gapAt, moves } from '../lib/drag';
import { logFresh, markAllSeen, markTaskRead, unseenOf, unseenPushes, type Seen } from '../lib/seen';
import { Icon, StateIcon } from '../components/Icon';
import { Editable, Empty, Pane, PushTags, Seg, Tool } from '../components/ui';
import { useBranch, useBranches, useBranchTree, useIndex, useTask, useTerminals, writeTask } from '../state/server';
import { onAgentClick, useAgentTab } from '../state/agentTab';
import { ask, copyText, setPref, setSeen, toggled, useUI } from '../state/ui';
import { FileThumb, TreeRows } from './Tree';

/** How the nav says where a branch stands. */
const BRANCH_SAID = { open: '进行中', merged: '已合并', abandoned: '已废弃' } as const;
const STATUS_WORD: Record<string, string> = { A: 'added', D: 'deleted', R: 'renamed', M: 'changed', C: 'copied', T: 'type changed' };

/** A task's artifacts folders that are open, as last left; every one starts closed. */
function useOpenFolders(id: string): readonly string[] {
  return useUI((s) => s.open[id]) ?? NONE;
}
const NONE: readonly string[] = [];

function setFolder(key: string, start: readonly string[], path: string, open: boolean): void {
  useUI.setState((s) => ({ open: { ...s.open, [key]: toggled(s.open[key] ?? start, path, open) } }));
}


const revealed = new Map<string, string>();
/** True the first time `item` is asked for under `key`, so its folders open then and can be closed after. */
function revealOnce(key: string, item: string): boolean {
  if (revealed.get(key) === item) return false;
  revealed.set(key, item);
  return true;
}


// ── a task's artifacts ─────────────────────────────────────────────────────

/**
 * The artifacts part of a task's column: their folders' tree, and nothing
 * above it to count or sort them by, since the folders already say what each
 * is. A hook, since what it shows is kept in the store.
 */
function useArtifactsPart(t: TaskSummary, d: TaskDetail | undefined, r: TaskRoute, index: Index, seen: Seen): { top: ReactNode; body: ReactNode } {
  const open = useOpenFolders(t.id);
  if (!d) return { top: <div className="section-head"><b>Artifacts</b><span>loading…</span></div>, body: null };
  const unseen = unseenOf(index, seen, t.id);
  const dotted = unseen.size > 0 || logFresh(seen, t.id, d.log?.entries.length);
  return {
    top: (
      <div className="section-head">
        <b>Artifacts</b><span className="grow" />
        {dotted ? <button type="button" className="tool text read-all" title="Clear every dot of this task" onClick={() => setSeen((s) => markTaskRead(index, s, t.id, d.log?.entries.length))}>全部已读</button> : null}
        {d.files.length ? <FoldAll id={t.id} files={d.files} open={open} /> : null}
        {d.files.length ? <Tool name="grid" label="See them all as a grid" href={link.folder(t.id, '')} newTab={false} small /> : null}
      </div>
    ),
    body: (
      <>
        {d.files.length ? (
          <div className="tree" role="tree" aria-label="Artifacts">
            <TreeRows node={buildTree(d.files)} options={{
              isOpen: (p) => open.includes(p),
              setOpen: (p, on) => setFolder(t.id, open, p, on),
              file: r.sub === 'file' ? r.path : null,
              folder: r.sub === 'folder' ? r.path : null,
              fileHref: (p) => link.file(t.id, p),
              folderHref: (p) => link.folder(t.id, p),
              isNew: (f) => unseen.has(f.path),
              newIn: (dir) => [...unseen.keys()].some((p) => p.startsWith(`${dir}/`)),
            }} />
          </div>
        ) : <div className="sublabel">No artifacts yet.</div>}
        {d.hidden.length ? <div className="hidden-note">{`Not shown: ${d.hidden.map((x) => `${x.name} (${x.count})`).join(', ')}`}</div> : null}
      </>
    ),
  };
}

/** Every folder of the artifacts opened at once, or, once any is open, every one closed. */
function FoldAll({ id, files, open }: { id: string; files: readonly { path: string }[]; open: readonly string[] }) {
  const closing = open.length > 0;
  const flip = (): void => useUI.setState((s) => ({ open: { ...s.open, [id]: closing ? [] : [...new Set(files.flatMap((f) => foldersAbove(f.path)))] } }));
  return <Tool name={closing ? 'fold' : 'unfold'} label={closing ? 'Collapse all' : 'Expand all'} onClick={flip} small />;
}

// ── a task's branch ────────────────────────────────────────────────────────

/** The branch part of a task's column: its changes, its commits or its files. */
function useBranchPart(t: TaskSummary, r: BranchRoute): { top: ReactNode; body: ReactNode } {
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

  if (!repo?.branch) return { top: <div className="sublabel">This task keeps no branch here.</div>, body: null };
  // The nav's row says which branch this is and where it stands; what is below is what it changed.
  if (!b) return { top: <div className="sublabel">Reading the branch…</div>, body: null };
  if (b.missing) return { top: <div className="sublabel error">{b.missing}</div>, body: null };

  const files = (shown ?? b).files;
  const tabs = <Seg wide options={[['changes', `Changes ${files.length}`], ['commits', `Commits ${b.commits.length}`], ['files', 'All files']] as const} current={r.tab} onPick={(tab) => { location.hash = inBranch(r, tab); }} />;
  const sourceCount = rules ? b.files.filter((f) => isSource(rules, f.path)).length : b.files.length;
  // Over the changes and the files alike; the commits are what they are.
  const switcher = r.tab === 'commits' ? null : (
    <button type="button" className="src-toggle" aria-pressed={sourceOnly} onClick={() => setPref('allFiles', sourceOnly)}>
      <span className="grow">Source code only</span>
      <span className="aside">{`${sourceCount} / ${b.files.length}`}</span>
      <span className="switch" aria-hidden="true"><span /></span>
    </button>
  );
  let list: ReactNode;
  if (r.tab === 'commits') {
    list = b.commits.map((c) => (
      <a key={c.sha} className={'commit-line' + ((r.item || b.commits[0]?.sha) === c.sha ? ' on' : '')} href={inBranch(r, 'commits', c.sha)}>
        <span className="mono">{short(c.sha)}</span><span className="grow">{c.subject}</span><span className="aside">{dayOf(c.at)}</span>
      </a>
    ));
  } else if (r.tab === 'files') {
    const open = filesOpen ?? [];
    list = !tree.data ? <div className="sublabel">reading the files…</div> : (
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
          lead: (f) => <span className={`status-letter ${f.status}`} title={STATUS_WORD[f.status] ?? ''}>{f.status === 'M' ? '' : f.status}</span>,
          extra: (f) => (f.add === null ? <span className="aside">binary</span> : <><span className="plus">{f.add ? `+${f.add}` : ''}</span><span className="minus">{f.del ? `−${f.del}` : ''}</span></>),
        }} />
        {!b.files.length ? <div className="sublabel">{`No changes against ${b.target}.`}</div> : null}
        {b.files.length && !files.length ? <div className="sublabel">No source code among the changes.</div> : null}
      </>
    );
  }
  return { top: <div className="stack">{tabs}{switcher}</div>, body: <div className="tree" role="tree">{list}</div> };
}

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
function MrRows({ t, r, ready }: { t: TaskSummary; r: Route; ready: boolean }) {
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
  const flip = (key: string, now: boolean): void => useUI.setState((s) => ({ unfolded: { ...s.unfolded, [key]: !now } }));
  const total = lists.reduce((n, l) => n + l.open, 0);

  const branchRow = (l: (typeof lists)[number], b: Listed, deep: boolean): ReactNode => {
    const on = !!shown && shown.repo === l.i && (shown.name || l.repo.branch) === b.name;
    // Its name is what a branch's row is wanted for most: a click copies it, and opens the branch too.
    return (
      <a key={`${l.i}:${b.name}`} className={'row other' + (deep ? ' deep' : '') + (on ? ' on' : '')} href={b.name === l.repo.branch ? link.branch(t.id, l.i) : link.branch(t.id, l.i, 'changes', '', b.name)}
        title={`${b.name}: click to copy`} onClick={() => copyText(b.name, '分支名已复制', 'The branch')}>
        <span className="grow mono">{b.name}</span>
        <span className="aside">{b.pr ? `${BRANCH_SAID.merged} PR #${b.pr}` : BRANCH_SAID[b.state]}</span>
      </a>
    );
  };
  const direct = lists.length === 1;
  return (
    <>
      <button type="button" className="row branch-row" aria-expanded={open} onClick={() => flip(fold, open)}>
        <Icon name="branch" size={16} />
        <span className="word">MR</span>
        <span className="grow" />
        {total ? <span className="aside">{`${total} ${BRANCH_SAID.open}`}</span> : null}
        <span className="fold"><Icon name={open ? 'up' : 'down'} size={15} /></span>
      </button>
      {open && direct ? (lists[0] as (typeof lists)[number]).branches.map((b) => branchRow(lists[0] as (typeof lists)[number], b, false)) : null}
      {open && !direct ? lists.flatMap((l) => {
        const key = `${t.id}:mr:${l.i}`;
        // Open until folded by hand, so one click on MR shows every branch.
        const here = unfolded[key] ?? true;
        return [
          <button key={key} type="button" className="row repo-row" aria-expanded={here} onClick={() => flip(key, here)}>
            <span className="grow">{l.repo.name}</span>
            {l.open ? <span className="aside">{`${l.open} ${BRANCH_SAID.open}`}</span> : null}
            <span className="fold"><Icon name={here ? 'up' : 'down'} size={14} /></span>
          </button>,
          ...(here ? l.branches.map((b) => branchRow(l, b, true)) : []),
        ];
      }) : null}
    </>
  );
}

/**
 * A resource under the Resources row: a web link is its name, opening in a
 * tab of its own; anything else is its name and its words. On hover, the
 * pencil edits where it points, keeping its kind, and the bin forgets it.
 */
function ResourceRow({ task, name, where, deep }: { task: string; name: string; where: string; deep: boolean }) {
  const [editing, setEditing] = useState(false);
  const url = isLink(where);
  const className = 'row other res-row' + (deep ? ' deep' : '');
  if (editing) {
    return (
      <div className={className}>
        <span className="res-name">{name}</span>
        <Editable className="grow res-edit" text={where} autoFocus onSave={(to) => void writeTask('/api/resource', { task, name, where: to }, `已保存 ${name}`)} onLeft={(changed) => { if (!changed) setEditing(false); }} />
      </div>
    );
  }
  return (
    <div className={className} title={where}>
      {url
        ? <a className="grow res-link" href={where.trim()} target="_blank" rel="noopener">{name}</a>
        : <><span className="res-name">{name}</span><span className="grow res-words">{where}</span></>}
      <span className="res-tools">
        <button type="button" className="ov-icon" title={`编辑 ${name}`} aria-label={`编辑 ${name}`} onClick={() => setEditing(true)}><Icon name="edit" size={14} /></button>
        <button type="button" className="ov-icon" title={`删除 ${name}`} aria-label={`删除 ${name}`}
          onClick={() => ask({ title: `删除资源 ${name}？`, sub: where, action: '删除', then: () => void writeTask('/api/resource', { task, name, remove: true }, `已删除 ${name}`) })}>
          <Icon name="trash" size={14} />
        </button>
      </span>
      {url ? <span className="go"><Icon name="external" size={14} /></span> : null}
    </div>
  );
}

/**
 * The Resources row under MR: what the task refers to, its agents aside,
 * folded until asked; under it a row for each kind, itself folded until
 * asked, so the row opens on the kinds there are, and under each its
 * resources, as MR has repositories and their branches. Resources of one
 * kind are straight under the row.
 */
function ResourceRows({ t, d, on }: { t: TaskSummary; d: TaskDetail; on: boolean }) {
  const unfolded = useUI((s) => s.unfolded);
  const resources = listResources(t, d);
  if (!resources.length) return null;
  const groups = Object.keys(KIND_WORD).map((kind) => [kind, resources.filter((r) => r.kind === kind)] as const).filter(([, here]) => here.length);
  const fold = `${t.id}:res`;
  const open = unfolded[fold] ?? false;
  const flip = (key: string, now: boolean): void => useUI.setState((s) => ({ unfolded: { ...s.unfolded, [key]: !now } }));
  const rows = (here: readonly Resource[], deep: boolean): ReactNode[] => here.map((r) => <ResourceRow key={r.name} task={t.id} name={r.name} where={r.where} deep={deep} />);
  return (
    <>
      <button type="button" className={'row branch-row' + (on ? ' on' : '')} aria-expanded={open} onClick={() => flip(fold, open)}>
        <Icon name="link" size={16} />
        <span className="word">Resources</span>
        <span className="grow" />
        <span className="aside">{`${resources.length} 个`}</span>
        <span className="fold"><Icon name={open ? 'up' : 'down'} size={15} /></span>
      </button>
      {open && groups.length === 1 ? rows((groups[0] as (typeof groups)[number])[1], false) : null}
      {open && groups.length > 1 ? groups.flatMap(([kind, here]) => {
        const key = `${t.id}:res:${kind}`;
        const shown = unfolded[key] ?? false;
        return [
          <button key={key} type="button" className="row repo-row" aria-expanded={shown} onClick={() => flip(key, shown)}>
            <span className="grow">{KIND_WORD[kind]}</span>
            <span className="aside">{here.length}</span>
            <span className="fold"><Icon name={shown ? 'up' : 'down'} size={14} /></span>
          </button>,
          ...(shown ? rows(here, true) : []),
        ];
      }) : null}
    </>
  );
}

/**
 * An Agent row under Log: one agent opens from it; several fold under it,
 * as a repository's branches do, newest first, and are dragged to another
 * order, the first being the one going to the task opens. While this page
 * holds the agent tab, what it shows there shimmers: the agent, or the word
 * Agent while they are folded.
 */
function AgentRows({ t, agents, on }: { t: TaskSummary; agents: readonly (readonly [string, string])[]; on: boolean }) {
  const fold = `${t.id}:agents`;
  const unfolded = useUI((s) => s.unfolded[fold]) ?? false;
  const showing = useAgentTab((s) => s.showing);
  // The order dropped, shown until the index comes back with it.
  const [dropped, setDropped] = useState<{ was: string; names: string[] } | null>(null);
  const [drag, setDrag] = useState<{ from: number; gap: number } | null>(null);
  const names = agents.map(([name]) => name);
  const order = dropped?.was === names.join('\n') ? dropped.names.flatMap((n) => agents.filter(([name]) => name === n)) : agents;
  const go = <span className="go"><Icon name="external" size={14} /></span>;
  const shim = (yes: boolean): string => (yes ? ' shimmer' : '');
  if (order.length === 1) {
    const [name, where] = order[0] as readonly [string, string];
    return (
      <a className={'row' + (on ? ' on' : '')} href={where} target={AGENT_TAB} title={`${name}: ${where}`} onClick={onAgentClick(where)}>
        <Icon name="cloud" size={16} /><span className="word">Agent</span><span className="grow" /><span className={'aside name' + shim(showing === where)}>{name}</span>{go}
      </a>
    );
  }
  const drop = (): void => {
    if (drag === null || !moves(drag.from, drag.gap)) return setDrag(null);
    const to = dropTo(order.map(([name]) => name), drag.from, drag.gap);
    setDropped({ was: names.join('\n'), names: to });
    setDrag(null);
    void writeTask('/api/agents', { task: t.id, order: to }, `${to[0] as string} 排到了第一`);
  };
  const line = (gap: number): ReactNode => (drag !== null && drag.gap === gap && moves(drag.from, gap) ? <div key={`gap${gap}`} className="drop-line" /> : null);
  return (
    <>
      <button type="button" className={'row branch-row' + (on ? ' on' : '')} aria-expanded={unfolded} onClick={() => useUI.setState((s) => ({ unfolded: { ...s.unfolded, [fold]: !unfolded } }))}>
        <Icon name="cloud" size={16} />
        <span className={'word' + shim(!unfolded && order.some(([, where]) => where === showing))}>Agent</span>
        <span className="grow" />
        <span className="aside">{`${order.length} 个`}</span>
        <span className="fold"><Icon name={unfolded ? 'up' : 'down'} size={15} /></span>
      </button>
      {unfolded ? order.flatMap(([name, where], i) => [
        line(i),
        <a key={name} className={'row other agent-row' + (drag?.from === i ? ' lifted' : '')} href={where} target={AGENT_TAB} title={where} draggable
          onClick={onAgentClick(where)}
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', name); setDrag({ from: i, gap: i }); }}
          onDragOver={(e) => {
            if (drag === null) return;
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect();
            const gap = gapAt(i, e.clientY < box.top + box.height / 2);
            if (gap !== drag.gap) setDrag({ ...drag, gap });
          }}
          onDrop={(e) => { e.preventDefault(); drop(); }}
          onDragEnd={() => setDrag(null)}>
          <span className="grip"><Icon name="grip" size={14} width={2.6} /></span>
          <span className={'grow' + shim(showing === where)}>{name}</span>{go}
        </a>,
        i === order.length - 1 ? line(i + 1) : null,
      ]) : null}
    </>
  );
}

function TaskIndex({ t, r, index, seen }: { t: TaskSummary; r: TaskRoute; index: Index; seen: Seen }) {
  const { data: d } = useTask(t.id);
  const terminal = useTerminals().data?.[t.id];
  const unseen = unseenOf(index, seen, t.id);
  const total = t.deliverables.done + t.deliverables.todo + t.deliverables.abandoned;
  const logCount = d?.log?.entries.length ?? 0;
  // Against what was last read, not what this visit started from: reading the log clears it.
  const fresh = !!d?.log && logFresh(seen, t.id, logCount);
  const artifacts = useArtifactsPart(t, d, r, index, seen);
  // Asked for on every route so the hooks run in the same order; off a branch, it reads none.
  const branch = useBranchPart(t, r.sub === 'branch' ? r : { view: 'task', id: t.id, sub: 'branch', repo: -1, name: null, tab: 'changes', item: '' });
  // An open branch takes the part that scrolls, and the artifacts wait at the foot.
  const part = r.sub === 'branch' ? branch : artifacts;
  const top = (
    <>
      <div className="task-head"><div className="t"><StateIcon state={t.state} size={18} /><h1>{t.title || t.id}</h1></div></div>
      <div className="nav">
        <a className={'row' + (r.sub === 'overview' ? ' on' : '')} href={link.task(t.id)}>
          <Icon name="overview" size={16} /><span className="grow">Overview</span><span className="aside">{total ? plural(total, 'deliverable') : 'problem'}</span>
        </a>
        {d?.files.some((f) => f.path === 'report.html') ? (
          <a className={'row' + (r.sub === 'report' ? ' on' : '')} href={link.report(t.id)}>
            <Icon name="check" size={16} /><span className="grow">Report</span>
            {unseen.has('report.html') ? <span className="dot" title="changed since your last look" /> : null}
            <span className="aside">report.html</span>
          </a>
        ) : null}
        <a className={'row' + (r.sub === 'log' ? ' on' : '')} href={link.log(t.id)}>
          <Icon name="log" size={16} /><span className="grow">Log</span>
          {fresh ? <span className="dot" title="new entries" /> : null}
          <span className="aside">{d ? logCount : ''}</span>
        </a>
        {terminal ? (
          <a className={'row' + (r.sub === 'terminal' ? ' on' : '')} href={link.terminal(t.id)}>
            <Icon name="terminal" size={16} /><span className="grow">Terminal</span>
            <span className={`aside term-status ${terminal.status}`}>{AGENT_WORD[terminal.status] || (terminal.agent ?? '')}</span>
          </a>
        ) : null}
        {t.agents.length ? <AgentRows t={t} agents={t.agents} on={r.sub === 'agent'} /> : null}
        {t.repos.some((repo) => repo.branch) ? <MrRows t={t} r={r} ready={!!d} /> : null}
        {d ? <ResourceRows t={t} d={d} on={r.sub === 'resources'} /> : null}
      </div>
      {part.top}
    </>
  );
  const foot = r.sub === 'branch' && d ? (
    <a className="row" href={link.folder(t.id, '')}>
      <span className="folder-icon dim"><Icon name="folder" size={15} /></span><span className="grow">Artifacts</span>
    </a>
  ) : null;
  return <Pane remember={t.id} top={top} body={part.body} foot={foot} />;
}

// ── Latest ─────────────────────────────────────────────────────────────────

/**
 * Latest: what arrived and has not been looked at, newest first, a line a
 * push: when, which task, and how many files it added, changed and deleted.
 * Each opens to its files, and a file opens on the right; the arrow at its
 * end opens the task itself, its overview. The push holding the file being
 * shown is open.
 */
function Feed({ index, seen, r }: { index: Index; seen: Seen; r: Extract<Route, { view: 'latest' }> }) {
  const feedOpen = useUI((s) => s.feedOpen);
  const pushes = unseenPushes(index, seen);
  const showing = r.id ? pushes.find((p) => p.task === r.id && p.files.some((f) => f.path === r.path)) : undefined;
  const unseen = new Map([...new Set(pushes.map((p) => p.task))].map((id) => [id, unseenOf(index, seen, id)]));
  const days: { label: string; items: ReactNode[] }[] = [];
  for (const p of pushes) {
    const label = dayLabel(p.at);
    if (days.at(-1)?.label !== label) days.push({ label, items: [] });
    const key = `${p.task}@${p.at}`;
    const open = feedOpen.includes(key) || p === showing;
    const t = index.tasks.find((x) => x.id === p.task);
    const toggle = (): void => {
      useUI.setState((s) => ({ feedOpen: open ? s.feedOpen.filter((k) => k !== key) : [...s.feedOpen, key] }));
      if (p === showing && open) location.hash = '#/latest';
    };
    (days.at(-1) as { items: ReactNode[] }).items.push(
      <div className="push" key={key}>
        {/* The arrow sits beside the line, not in it: a link cannot sit inside the button that opens the files. */}
        <div className="push-line">
          <button type="button" className={'push-head' + (open ? ' open' : '')} aria-expanded={open} title={`${t?.title || p.task} · ${p.task}`} onClick={toggle}>
            <span className="chev"><Icon name="chev" size={14} /></span>
            <b>{clock(p.at)}</b>
            <span className="name">{t?.title || p.task}</span>
            <span className="tags"><PushTags files={p.files} /></span>
          </button>
          <Tool name="go" label="Open the task" href={link.task(p.task)} newTab={false} small />
        </div>
        {open ? p.files.map((f) => {
          const name = baseName(f.path);
          const where = <span className="grow"><span className="dim">{dirName(f.path) ? dirName(f.path) + '/' : ''}</span>{name}</span>;
          if (f.status === 'D') {
            return <div key={f.path} className="row gone" title={`${p.task}/${f.path}, deleted`}><span className="kind">{badge(name)}</span>{where}<span className="tag gone">deleted</span></div>;
          }
          const on = r.id === p.task && r.path === f.path && p === showing;
          return (
            <a key={f.path} className={'row' + (on ? ' on' : '')} href={link.latest(p.task, f.path)} title={`${p.task}/${f.path}`}>
              <FileThumb path={f.path} sha={f.sha} />{where}
              {unseen.get(p.task)?.has(f.path) ? <span className="dot" title="new since your last look" /> : null}
              {f.status === 'A' ? <span className="tag new">new</span> : null}
            </a>
          );
        }) : null}
      </div>,
    );
  }
  const heading = (
    <div className="section-head" style={{ padding: '0 10px' }}>
      <h1 style={{ margin: 0, fontSize: '19px', lineHeight: '26px' }}>Latest</h1>
      <span className="grow" />
      <button type="button" className="tool text" style={{ height: '28px', color: 'var(--accent)', fontSize: '12.5px' }} onClick={() => setSeen((s) => markAllSeen(index, s))}>Mark all seen</button>
    </div>
  );
  const body = (
    <>
      {!pushes.length ? <div className="sublabel">{index.latest.length ? 'Nothing new since you last looked.' : 'Nothing has arrived in any task’s artifacts yet.'}</div> : null}
      {days.map((d) => <div className="group" style={{ gap: '2px' }} key={d.label}><div className="feed-day">{d.label}</div>{d.items}</div>)}
    </>
  );
  return <Pane remember="latest" top={heading} body={body} />;
}

export function Middle() {
  const r = useRoute();
  const { data: index } = useIndex();
  const seen = useUI((s) => s.seen);
  const hash = useHash();

  // The row of what is being shown, kept in view when the route moves to it.
  useLayoutEffect(() => {
    const scroller = document.querySelector<HTMLElement>('.middle .pane-scroll');
    const on = scroller?.querySelector('.row.on, .commit-line.on');
    if (!scroller || !on) return;
    const a = on.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    if (a.top < b.top || a.bottom > b.bottom) on.scrollIntoView({ block: 'center' });
  }, [hash]);

  let inner: ReactNode = null;
  if (index && seen) {
    if (r.view === 'latest') inner = <Feed index={index} seen={seen} r={r} />;
    else {
      const t = index.tasks.find((x) => x.id === r.id);
      inner = t ? <TaskIndex key={t.id} t={t} r={r} index={index} seen={seen} /> : <Empty title={`No ${r.id} here`}>{`The vault ${index.vault.name} has no task called ${r.id}.`}</Empty>;
    }
  }
  return <aside className="middle">{inner}</aside>;
}

