import { useState, type ReactNode } from 'react';
import { stateOf, type Index, type TaskSummary } from '../lib/api';
import { isPaused } from '../lib/stops';
import { copyText } from '../state/ui';
import { Icon } from './Icon';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

const STATES = { open: 'In progress', uat: 'In review', done: 'Done', abandoned: 'Abandoned' } as const;

/** One fact about the task: what it is, and what it says. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-4 py-2.5 text-[13.5px]">
      <span className="w-20 flex-none text-ink-3">{name}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

/**
 * What a task is, beside what it is about: the facts yan keeps of it that
 * the rest of its column has no place for, opened from the mark after its
 * title. Which vault it is in is the first of them, and whether that vault
 * is local, kept on this machine alone, or remote, shared through its
 * origin, since that says where its notes go. More of a task's own facts
 * belong here as they come.
 */
export function TaskInfo({ t, index }: { t: TaskSummary; index: Index }) {
  const [open, setOpen] = useState(false);
  // The task's vault among those served, or the one vault there is.
  const vaults = index.status.vaults ?? [];
  const home = vaults.find((v) => v.name === t.vault) ?? vaults[0];
  const name = home?.name ?? index.vault.name;
  const local = home?.local ?? index.status.local;
  const folder = `${home?.dir ?? index.vault.dir}/tasks/${t.id}`;
  return (
    <>
      <Button variant="ghost" size="icon-xs" className="mt-0.5 flex-none text-ink-3" aria-label="About this task" title="About this task" onClick={() => setOpen(true)}>
        <Icon name="info" size={15} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 sm:max-w-[460px]">
          <DialogHeader className="pb-1">
            <DialogTitle>About this task</DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col divide-y divide-sunken">
            <Fact name="Task"><b>{t.id}</b><span className="wrap-anywhere">{t.title}</span></Fact>
            <Fact name="State">{isPaused(t) ? 'Paused' : STATES[stateOf(t.state)]}</Fact>
            <Fact name="Vault">
              <b>{name}</b>
              <Badge variant="secondary">{local ? 'Local' : 'Remote'}</Badge>
              <span className="basis-full text-[12.5px] leading-[18px] text-ink-3">
                {local ? 'Kept on this machine alone: its notes are never pulled or pushed.' : 'Shared through its origin: its notes are pulled and pushed as agents work.'}
              </span>
            </Fact>
            <Fact name="Folder">
              <Button variant="ghost" size="xs" className="max-w-full min-w-0 justify-start font-mono text-xs font-normal" title="Copy the path on this machine" onClick={() => copyText(folder, 'Path copied', 'The path')}>
                <span className="truncate">{folder}</span><Icon name="copy" size={13} />
              </Button>
            </Fact>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
