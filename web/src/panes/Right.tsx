import { Fragment, type ReactNode } from 'react';
import type { Index, TaskDetail } from '../lib/api';
import { buildTree, dirName, treeOrder } from '../lib/files';
import { link, useRoute, viewKey, type Route } from '../lib/route';
import { feedFiles, markLooked, unseenPushes } from '../lib/seen';
import { Empty } from '../components/ui';
import { queryClient, useIndex, useTask } from '../state/server';
import { setSeen, useUI } from '../state/ui';
import { AgentView } from '../views/Agent';
import { ResourcesView } from '../views/Resources';
import { BranchView } from '../views/Branch';
import { FileView } from '../views/File';
import { FolderView } from '../views/Folder';
import { LogView } from '../views/Log';
import { Overview } from '../views/Overview';
import { ReportView } from '../views/Report';
import { useKeyNav } from '../views/nav';

/**
 * What the page shows at `r` that a look clears: a file, the report, or the
 * log. Opening it is a look; so is a click in it, when a push changed it
 * while it was open.
 */
export function lookAt(r: Route, index: Index): void {
  if (r.view === 'latest') {
    if (r.id && r.path) setSeen((s) => markLooked(index, s, r.id as string, r.path));
    return;
  }
  if (r.sub === 'file') setSeen((s) => markLooked(index, s, r.id, r.path));
  else if (r.sub === 'report') setSeen((s) => markLooked(index, s, r.id, 'report.html'));
  else if (r.sub === 'log') {
    const n = queryClient.getQueryData<TaskDetail>(['task', r.id])?.log?.entries.length;
    if (n !== undefined) setSeen((s) => (s.logs[r.id] === n ? null : { ...s, logs: { ...s.logs, [r.id]: n } }));
  }
}

function Nothing({ title, children }: { title: string; children?: ReactNode }) {
  useKeyNav(null, null);
  return <Empty title={title}>{children}</Empty>;
}

function Shown({ r, index }: { r: Route; index: Index }) {
  const seen = useUI((s) => s.seen);
  const known = r.id !== undefined && index.tasks.some((t) => t.id === r.id);
  const { data: d } = useTask(known ? r.id : undefined);

  if (r.view === 'latest') {
    if (!r.id) {
      const any = seen ? unseenPushes(index, seen).length > 0 : false;
      return <Nothing title="Latest">{any ? 'Open an update on the left, then one of its files, to see it here.' : 'When an agent pushes something new, it shows up here.'}</Nothing>;
    }
    if (!d) return <Nothing title="Loading…" />;
    const file = d.files.find((f) => f.path === r.path);
    if (!file) return <Nothing title="Not there any more">{`${r.path} is no longer in ${r.id}'s artifacts.`}</Nothing>;
    const list = seen ? feedFiles(index, seen) : [];
    const at = list.findIndex((f) => f.task === r.id && f.path === r.path);
    const before = list[at - 1];
    const after = list[at + 1];
    return (
      <FileView task={r.id} file={file}
        prev={at > 0 && before ? link.latest(before.task, before.path) : null}
        next={at >= 0 && after ? link.latest(after.task, after.path) : null}
        pos={at + 1} total={list.length}
        folderFiles={d.files.filter((f) => dirName(f.path) === dirName(file.path))}
        fileHref={(p) => link.latest(r.id, p)}
        taskTitle={index.tasks.find((t) => t.id === r.id)?.title} />
    );
  }

  const t = index.tasks.find((x) => x.id === r.id);
  if (!t) return <Nothing title="No such task">{`There is no ${r.id} in this vault.`}</Nothing>;
  if (!d) return <Nothing title="Loading…" />;
  if (r.sub === 'overview') return <Overview t={t} d={d} />;
  if (r.sub === 'log') return <LogView t={t} d={d} />;
  if (r.sub === 'report') return <ReportView t={t} d={d} />;
  if (r.sub === 'folder') return <FolderView t={t} d={d} path={r.path} />;
  if (r.sub === 'branch') return <BranchView t={t} r={r} />;
  if (r.sub === 'agent') return <AgentView t={t} />;
  if (r.sub === 'resources') return <ResourcesView t={t} d={d} />;
  if (r.sub !== 'file') return null;
  const file = d.files.find((f) => f.path === r.path);
  if (!file) return <Nothing title="Not there any more">{`${r.path} is not in ${t.id}'s artifacts at the commit being shown.`}</Nothing>;
  const siblings = treeOrder(buildTree(d.files.filter((f) => dirName(f.path) === dirName(file.path))));
  const at = siblings.findIndex((f) => f.path === file.path);
  const before = siblings[at - 1];
  const after = siblings[at + 1];
  return (
    <FileView task={t.id} file={file}
      prev={before ? link.file(t.id, before.path) : null}
      next={after ? link.file(t.id, after.path) : null}
      pos={at + 1} total={siblings.length}
      folderFiles={d.files.filter((f) => dirName(f.path) === dirName(file.path))}
      fileHref={(p) => link.file(t.id, p)} />
  );
}

/**
 * The right pane: whatever was picked, shown as what it is. A view is kept
 * for as long as it shows the same thing, whatever arrives meanwhile, so its
 * scroll, what is playing in it and what is open in it all stay; picking
 * something else starts the next view afresh.
 */
export function Right() {
  const r = useRoute();
  const { data: index, error } = useIndex();
  let shown: ReactNode = null;
  if (index) shown = <Shown r={r} index={index} />;
  else if (error) shown = <Empty title="Can't reach yan serve">{String(error.message)}</Empty>;
  return (
    // A click in what is open is a look at it: what a push changed under the reader waits for one.
    <main className="right" id="right" onPointerDown={() => { if (index) lookAt(r, index); }}>
      <Fragment key={viewKey(r)}>{shown}</Fragment>
    </main>
  );
}
