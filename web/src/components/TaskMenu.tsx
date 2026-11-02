import { useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { postJSON, type TaskSummary, type WriteResult } from '../lib/api';
import { go, link } from '../lib/route';
import { goesOn, isPaused } from '../lib/stops';
import { onStatus, queryClient, useIndex, useTerminals, writeTask } from '../state/server';
import { toast, useUI, type TaskAct } from '../state/ui';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';

/**
 * A task's own menu, in place of the browser's, on a right click on its
 * row in the task list or its square on the rail: rename it; while it is
 * open, pause it, or have its agent close it, done or given up; while it is
 * paused, resume it, which asks nothing, as it takes nothing away. `render`
 * is the row itself, which a click still follows.
 */
export function TaskMenu({ t, render, children }: { t: TaskSummary; render: ReactElement; children: ReactNode }) {
  const open = (kind: TaskAct['kind']): void => useUI.setState({ taskAct: { kind, id: t.id } });
  return (
    <ContextMenu>
      <ContextMenuTrigger render={render}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onClick={() => open('rename')}>Rename</ContextMenuItem>
        {isPaused(t) ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void writeTask('/api/task/resume', { task: t.id }, `Resumed ${t.id}`)}>Resume</ContextMenuItem>
          </>
        ) : null}
        {goesOn(t) ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => open('pause')}>Pause</ContextMenuItem>
            <ContextMenuItem onClick={() => open('done')}>Done</ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={() => open('abandon')}>Abandon</ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** What the box says for `act` on the task called `title`, its agent running here or not; `field` names the line it asks for. */
function wordsOf(act: TaskAct, title: string, running: boolean): { title: string; sub?: string; action: string; field?: string } {
  const who = running ? 'Its agent' : 'An agent started on it in a new herdr tab';
  const how = 'returning its worktrees, and asks you in its terminal when one holds work that looks unsaved.';
  if (act.kind === 'rename') return { title: `Rename ${act.id}`, action: 'Rename', field: 'Title' };
  if (act.kind === 'pause') {
    return {
      title: `Pause ${act.id}?`,
      sub: running
        ? `Its agent saves the work of “${title}”, committing and pushing it, and pauses it as yan:pause does, returning its worktrees; its terminal closes once that is through. Resume takes it up again.`
        : `“${title}” is paused at once, its worktrees here returned, when they hold nothing unsaved; else an agent started on it in a new herdr tab saves its work first. Resume takes it up again.`,
      action: 'Pause',
    };
  }
  if (act.kind === 'done') return { title: `Close ${act.id} as done?`, sub: `${who} closes “${title}” as yan:done does, ${how}`, action: 'Ask the agent' };
  return { title: `Give up ${act.id}?`, sub: `${who} closes “${title}” as given up, with your reason, ${how}`, action: 'Give up', field: 'Why it is given up' };
}

/** A change serve made itself, said in a toast, and shown once the vault has it. */
function said(out: WriteResult, what: string): void {
  toast(out.warning ? `${what}, but the push failed: ${out.warning}` : what, !!out.warning);
  void onStatus(out.status);
}

/**
 * What `act` asks of serve, with the line typed. A new title is written
 * and pushed as any change from the page is, and so is a pause serve could
 * make itself. A closing, and a pause with work to save, is the agent's:
 * serve types it into the agent running here or starts one with it, and
 * the page goes to the task's terminal, once it lists the tab started, to
 * watch it.
 */
async function perform(act: TaskAct, line: string): Promise<void> {
  if (act.kind === 'rename') return said(await postJSON<WriteResult>('/api/task/title', { task: act.id, title: line }), `Renamed ${act.id}`);
  if (act.kind === 'pause') {
    const out = await postJSON<WriteResult | { typed: true } | { launch: string }>('/api/task/pause', { task: act.id });
    if ('ok' in out) return said(out, `Paused ${act.id}`);
  } else {
    await postJSON('/api/task/close', act.kind === 'abandon' ? { task: act.id, abandon: line } : { task: act.id });
  }
  await queryClient.invalidateQueries({ queryKey: ['terminals'] });
  go(link.terminal(act.id));
}

/**
 * The box a task's menu opens over the page. Its button waits for serve's
 * answer, the box staying open meanwhile; one refused says why in the box,
 * which stays open to be asked again, with the way to the task's terminal
 * when its agent is the one to answer first.
 */
export function TaskActModal() {
  const act = useUI((s) => s.taskAct);
  const { data: index } = useIndex();
  const { data: terminals } = useTerminals();
  // The last one asked stays drawn while the box closes, and each one asked starts afresh.
  const [held, setHeld] = useState<TaskAct | null>(act);
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleOf = (id: string): string => index?.tasks.find((t) => t.id === id)?.title ?? '';
  if (act !== null && act !== held) {
    setHeld(act);
    setLine(act.kind === 'rename' ? titleOf(act.id) : '');
    setError(null);
  }
  const field = useRef<HTMLInputElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const title = held === null ? '' : titleOf(held.id);
  const running = held !== null && terminals?.[held.id] !== undefined;
  const words = held === null ? null : wordsOf(held, title, running);
  const given = line.trim();
  const ready = held?.kind === 'done' || held?.kind === 'pause' || (given !== '' && !(held?.kind === 'rename' && given === title));
  const close = (): void => useUI.setState({ taskAct: null });

  const submit = async (): Promise<void> => {
    if (held === null || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await perform(held, given);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  return (
    <AlertDialog open={act !== null} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <AlertDialogContent initialFocus={words?.field ? field : action}>
        <AlertDialogHeader>
          <AlertDialogTitle>{words?.title}</AlertDialogTitle>
          {words?.sub ? <AlertDialogDescription>{words.sub}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {words?.field ? (
          <Input ref={field} aria-label={words.field} placeholder={words.field} value={line} disabled={busy}
            onFocus={(e) => e.currentTarget.select()} onChange={(e) => setLine(e.target.value)} onKeyDown={onKey} />
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] leading-5 text-destructive">
            {error}
            {running && held?.kind !== 'rename' ? (
              <>
                {' '}
                <a className="underline underline-offset-3 hover:text-foreground" href={link.terminal(held.id)} onClick={close}>Go to its terminal</a>
              </>
            ) : null}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/* Waiting, it keeps its name, and says it is busy. */}
          <Button ref={action} variant={held?.kind === 'abandon' ? 'destructive' : 'default'} disabled={!ready || busy} aria-busy={busy} onClick={() => void submit()}>
            {busy ? <Spinner aria-hidden /> : null}
            {words?.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
