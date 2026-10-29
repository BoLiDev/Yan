import { useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { Index, TaskDetail, TaskSummary } from '../lib/api';
import { badge, baseName, buildTree, changeOrder, dirName, foldersAbove } from '../lib/files';
import { clock, dayLabel, dayOf, plural, short } from '../lib/format';
import { inBranch, link, useHash, useRoute, type BranchRoute, type Route, type TaskRoute } from '../lib/route';
import { logFresh, markAllSeen, markTaskRead, unseenOf, unseenPushes, type Seen } from '../lib/seen';
import { Icon, StateIcon } from '../components/Icon';
import { Empty, Pane, PushTags, Seg, Tool } from '../components/ui';
import { useBranch, useBranches, useBranchTree, useIndex, useTask } from '../state/server';
import { copyText, setSeen, toggled, useUI } from '../state/ui';
import { FileThumb, TreeRows } from './Tree';

/** How the nav says where a branch stands. */
const BRANCH_SAID = { open: '进行中', merged: '已合并', abandoned: '已废弃' } as const;
const STATUS_WORD: Record<string, string> = { A: 'added', D: 'deleted', R: 'renamed', M: 'changed', C: 'copied', T: 'type changed' };

/** Folders open by default when there are few files; past that, closed until opened. */
function defaultOpen(files: readonly { path: string }[]): string[] {
  if (files.length > 40) return [];
  return [...new Set(files.flatMap((f) => foldersAbove(f.path)))];
}

/** A task's artifacts folders that are open, as last left or as they start. */
function useOpenFolders(id: string, files: readonly { path: string }[] | undefined): readonly string[] {
  const kept = useUI((s) => s.open[id]);
  return useMemo(() => kept ?? (files ? defaultOpen(files) : []), [kept, files]);
}

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
  const open = useOpenFolders(t.id, d?.files);
  if (!d) return { top: <div className="section-head"><b>Artifacts</b><span>loading…</span></div>, body: null };
  const unseen = unseenOf(index, seen, t.id);
  const dotted = unseen.size > 0 || logFresh(seen, t.id, d.log?.entries.length);
  return {
    top: (
      <div className="section-head">
        <b>Artifacts</b><span className="grow" />
        {dotted ? <button type="button" className="tool text read-all" title="Clear every dot of this task" onClick={() => setSeen((s) => markTaskRead(index, s, t.id, d.log?.entries.length))}>全部已读</button> : null}
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
  const cur = b && !b.missing ? r.item || changeOrder(b)[0]?.path : undefined;

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

  const tabs = <Seg wide options={[['changes', `Changes ${b.files.length}`], ['commits', `Commits ${b.commits.length}`], ['files', 'All files']] as const} current={r.tab} onPick={(tab) => { location.hash = inBranch(r, tab); }} />;
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
      <TreeRows node={buildTree(tree.data)} options={{
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
        <TreeRows node={buildTree(b.files)} options={{
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
      </>
    );
  }
  return { top: tabs, body: <div className="tree" role="tree">{list}</div> };
}

/** A repository's Branch row, folded until asked, and under it every branch the task kept there. */
function BranchRows({ t, i, r, ready }: { t: TaskSummary; i: number; r: Route; ready: boolean }) {
  const repo = t.repos[i] as TaskSummary['repos'][number];
  const names = useMemo(() => [repo.branch, ...[...repo.earlier].reverse()].filter((n): n is string => !!n), [repo]);
  // The branch the tree was last on is read under no name, the others under theirs.
  const views = useBranches(t.id, i, names.map((n) => (n === repo.branch ? null : n)), ready);
  const fold = `${t.id}:${i}`;
  const here = r.view === 'task' && r.sub === 'branch' && r.repo === i;
  const unfolded = useUI((s) => s.unfolded[fold]) ?? here;
  const stateOf = (k: number): keyof typeof BRANCH_SAID => (views[k]?.merged ? 'merged' : repo.abandoned.includes(names[k] as string) ? 'abandoned' : 'open');
  // In progress first, the one the tree was last on leading; then merged, then abandoned, newest first in each.
  const listed = (['open', 'merged', 'abandoned'] as const).flatMap((state) => names.map((_, k) => k).filter((k) => stateOf(k) === state));
  const open = listed.filter((k) => stateOf(k) === 'open').length;
  return (
    <>
      <button type="button" className="row branch-row" aria-expanded={unfolded} onClick={() => useUI.setState((s) => ({ unfolded: { ...s.unfolded, [fold]: !unfolded } }))}>
        <Icon name="branch" size={16} />
        <span className="word">Branch</span>
        {t.repos.length > 1 ? <span className="repo">{repo.name}</span> : null}
        <span className="grow" />
        {open ? <span className="aside">{`${open} ${BRANCH_SAID.open}`}</span> : null}
        <span className="fold"><Icon name={unfolded ? 'up' : 'down'} size={15} /></span>
      </button>
      {unfolded ? listed.map((k) => {
        const name = names[k] as string;
        const on = here && r.view === 'task' && r.sub === 'branch' && (r.name || repo.branch) === name;
        const pr = views[k]?.merged?.pr;
        // Its name is what a branch's row is wanted for most: a click copies it, and opens the branch too.
        return (
          <a key={name} className={'row other' + (on ? ' on' : '')} href={name === repo.branch ? link.branch(t.id, i) : link.branch(t.id, i, 'changes', '', name)}
            title={`${name}: click to copy`} onClick={() => copyText(name, '分支名已复制', 'The branch')}>
            <span className="grow mono">{name}</span>
            <span className="aside">{pr ? `${BRANCH_SAID.merged} PR #${pr}` : BRANCH_SAID[stateOf(k)]}</span>
          </a>
        );
      }) : null}
    </>
  );
}

/**
 * The tab every task's agents open in. A link given this target opens it once and loads into it after,
 * from any task, so looking at another agent takes the tab rather than adding one; `noopener` would cut
 * the tab off from this page and open a new one each time, so these links go without it.
 */
const AGENT_TAB = 'yan-agent';

/** The task's agents running elsewhere, as on a cloud platform: its run resources that are web links. */
function agentsOf(d: TaskDetail | undefined): (readonly [string, string])[] {
  return d ? d.resources.filter(([name, where]) => d.resourceKinds[name] === 'run' && /^https?:\/\//i.test(where)) : [];
}

/** An Agent row under Log: one agent opens from it; several fold under it, as a repository's branches do. */
function AgentRows({ t, agents }: { t: TaskSummary; agents: readonly (readonly [string, string])[] }) {
  const fold = `${t.id}:agents`;
  const unfolded = useUI((s) => s.unfolded[fold]) ?? false;
  const go = <span className="go"><Icon name="external" size={14} /></span>;
  if (agents.length === 1) {
    const [name, where] = agents[0] as readonly [string, string];
    return (
      <a className="row" href={where} target={AGENT_TAB} title={`${name}: ${where}`}>
        <Icon name="cloud" size={16} /><span className="word">Agent</span><span className="grow" /><span className="aside name">{name}</span>{go}
      </a>
    );
  }
  return (
    <>
      <button type="button" className="row branch-row" aria-expanded={unfolded} onClick={() => useUI.setState((s) => ({ unfolded: { ...s.unfolded, [fold]: !unfolded } }))}>
        <Icon name="cloud" size={16} />
        <span className="word">Agent</span>
        <span className="grow" />
        <span className="aside">{`${agents.length} 个`}</span>
        <span className="fold"><Icon name={unfolded ? 'up' : 'down'} size={15} /></span>
      </button>
      {unfolded ? agents.map(([name, where]) => (
        <a key={name} className="row other" href={where} target={AGENT_TAB} title={where}><span className="grow">{name}</span>{go}</a>
      )) : null}
    </>
  );
}

function TaskIndex({ t, r, index, seen }: { t: TaskSummary; r: TaskRoute; index: Index; seen: Seen }) {
  const { data: d } = useTask(t.id);
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
        {agentsOf(d).length ? <AgentRows t={t} agents={agentsOf(d)} /> : null}
        {t.repos.map((repo, i) => (repo.branch ? <BranchRows key={`${i}:${repo.name}`} t={t} i={i} r={r} ready={!!d} /> : null))}
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

