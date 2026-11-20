import { useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { create } from 'zustand';
import { postJSON, type WriteResult } from '../lib/api';
import { baseName } from '../lib/files';
import { composing } from '../lib/keys';
import { go, link, parseRoute } from '../lib/route';
import { wrote } from '../state/server';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';

/** What was asked of an artifact from its menu: a file, or a folder of them. */
interface ArtifactAct {
  readonly kind: 'rename' | 'delete';
  readonly task: string;
  readonly path: string;
  readonly dir: boolean;
}

/** The one being asked about, its box open; the box is drawn once, by the page. */
const useAct = create<{ act: ArtifactAct | null }>(() => ({ act: null }));

/**
 * An artifact's own menu, in place of the browser's, on a right click on
 * its row in a task's artifacts: rename it where it is, or delete it; a
 * folder with all it holds. `render` is the row itself, which a click
 * still follows.
 */
export function ArtifactMenu({ task, path, dir, render, children }: { task: string; path: string; dir: boolean; render: ReactElement; children: ReactNode }) {
  const open = (kind: ArtifactAct['kind']): void => useAct.setState({ act: { kind, task, path, dir } });
  return (
    <ContextMenu>
      <ContextMenuTrigger render={render}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onClick={() => open('rename')}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => open('delete')}>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Where the page goes once `act` is done as `name`, when what it shows was
 * the artifact or was in the folder: to it under its new name, or, deleted,
 * to the task. Null when the page shows something else, and stays.
 */
function after(act: ArtifactAct, name: string | null): string | null {
  const r = parseRoute(location.hash);
  if (r.view !== 'task' || r.id !== act.task || (r.sub !== 'file' && r.sub !== 'folder')) return null;
  const inside = r.path.startsWith(`${act.path}/`);
  if (r.path !== act.path && !inside) return null;
  if (name === null) return link.task(act.task);
  const to = [...act.path.split('/').slice(0, -1), name].join('/') + r.path.slice(act.path.length);
  return r.sub === 'file' ? link.file(act.task, to) : link.folder(act.task, to);
}

/** What `act` asks of serve, `name` the new one typed: written, committed and pushed as any change from the page is. */
async function perform(act: ArtifactAct, name: string): Promise<void> {
  const was = baseName(act.path);
  const out = act.kind === 'rename'
    ? await postJSON<WriteResult>('/api/artifact/rename', { task: act.task, path: act.path, name })
    : await postJSON<WriteResult>('/api/artifact/remove', { task: act.task, path: act.path });
  const to = after(act, act.kind === 'rename' ? name : null);
  wrote(out, act.kind === 'rename' ? `Renamed ${was}` : `Deleted ${was}`);
  if (to !== null) go(to);
}

/**
 * The box an artifact's menu opens over the page: its new name, the part
 * before its ending selected to be typed over, or whether it is to go. Its
 * button waits for serve's answer; one refused says why in the box, which
 * stays open to be asked again.
 */
export function ArtifactActModal() {
  const act = useAct((s) => s.act);
  // The last one asked stays drawn while the box closes, and each one asked starts afresh.
  const [held, setHeld] = useState<ArtifactAct | null>(act);
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (act !== null && act !== held) {
    setHeld(act);
    setLine(baseName(act.path));
    setError(null);
  }
  const field = useRef<HTMLInputElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const was = held === null ? '' : baseName(held.path);
  const given = line.trim();
  const renaming = held?.kind === 'rename';
  const ready = !renaming || (given !== '' && given !== was);
  const close = (): void => useAct.setState({ act: null });

  const submit = async (): Promise<void> => {
    if (held === null || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await perform(held, given);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Back in the name, which let go of the typing while it waited, to be typed again; once it is drawn as it can be.
      requestAnimationFrame(() => field.current?.focus());
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || composing(e.nativeEvent)) return;
    e.preventDefault();
    void submit();
  };
  /** A file's name without its ending, which is what is most often changed; a folder's whole. */
  const select = (el: HTMLInputElement): void => {
    const dot = held?.dir ? -1 : el.value.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  };

  return (
    <AlertDialog open={act !== null} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <AlertDialogContent initialFocus={renaming ? field : action}>
        <AlertDialogHeader>
          <AlertDialogTitle>{renaming ? `Rename ${was}` : `Delete ${was}?`}</AlertDialogTitle>
          {renaming ? null : (
            <AlertDialogDescription>
              {held?.dir ? `The folder ${held.path} and all it holds are deleted from the vault.` : `${held?.path ?? ''} is deleted from the vault.`}
              {' '}Git still has it, in the vault's history.
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {renaming ? (
          <Input ref={field} aria-label="Name" placeholder="Name" value={line} disabled={busy}
            onFocus={(e) => select(e.currentTarget)} onChange={(e) => setLine(e.target.value)} onKeyDown={onKey} />
        ) : null}
        {error ? <p role="alert" className="text-[13px] leading-5 text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/* Waiting, it keeps its name, and says it is busy. */}
          <Button ref={action} variant={renaming ? 'default' : 'destructive'} disabled={!ready || busy} aria-busy={busy} onClick={() => void submit()}>
            {busy ? <Spinner aria-hidden /> : null}
            {renaming ? 'Rename' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
