import type { ReactNode } from 'react';
import type { Index, TaskDetail, TaskSummary } from '../../lib/api';
import { buildTree, foldersAbove } from '../../lib/files';
import { link, type TaskRoute } from '../../lib/route';
import { logFresh, markTaskRead, unseenOf, type Seen } from '../../lib/seen';
import { GROW, SUBLABEL, Tool } from '../../components/page';
import { Button } from '../../components/ui/button';
import { setSeen, useUI } from '../../state/ui';
import { TreeRows } from '../Tree';
import { setFolder, useOpenFolders } from './folds';
import { SECTION, SECTION_TITLE } from './look';

/**
 * The artifacts part of a task's column: their folders' tree, and nothing
 * above it to count or sort them by, since the folders already say what each
 * is. A hook, since what it shows is kept in the store.
 */
export function useArtifactsPart(t: TaskSummary, d: TaskDetail | undefined, r: TaskRoute, index: Index, seen: Seen): { top: ReactNode; body: ReactNode } {
  const open = useOpenFolders(t.id);
  if (!d) return { top: <div className={SECTION}><b className={SECTION_TITLE}>Artifacts</b><span className="text-[12px] text-ink-3">loading…</span></div>, body: null };
  const unseen = unseenOf(index, seen, t.id);
  const dotted = unseen.size > 0 || logFresh(seen, t.id, d.log?.entries.length);
  return {
    top: (
      <div className={SECTION}>
        <b className={SECTION_TITLE}>Artifacts</b><span className={GROW} />
        {dotted ? <Button variant="ghost" size="xs" className="text-brand hover:text-brand-ink" title="Clear every dot of this task" onClick={() => setSeen((s) => markTaskRead(index, s, t.id, d.log?.entries.length))}>Mark all read</Button> : null}
        {d.files.length ? <FoldAll id={t.id} files={d.files} open={open} /> : null}
        {d.files.length ? <Tool name="grid" label="See them all as a grid" href={link.folder(t.id, '')} newTab={false} small /> : null}
      </div>
    ),
    body: (
      <>
        {d.files.length ? (
          <div className="flex flex-col gap-px" role="tree" aria-label="Artifacts">
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
        ) : <div className={SUBLABEL}>No artifacts yet.</div>}
        {/* What the vault keeps out of the tree, said faintly under it. */}
        {d.hidden.length ? <div className="px-2.5 pt-1.5 text-[12px] text-ink-4">{`Not shown: ${d.hidden.map((x) => `${x.name} (${x.count})`).join(', ')}`}</div> : null}
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
