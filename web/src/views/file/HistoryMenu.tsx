import { useState } from 'react';
import type { ArtifactFile } from '../../lib/api';
import { when } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu';
import { useUI } from '../../state/ui';
import { saidOf, useHistory } from './history';

/** The versions a menu lists: the recent ones are what is looked for. */
const LISTED = 12;

/**
 * History, beside a Markdown file's Rendered and Source: a menu of its
 * last changes, the newest first, each with when it was, how it came
 * about and how many lines it added and took out. Picking one shows what
 * it changed, in place of the file (`MarkdownHistory`); the file is shown
 * as itself until one is picked. The versions are asked for when the menu
 * first opens.
 */
export function HistoryMenu({ task, file }: { task: string; file: ArtifactFile }) {
  const [open, setOpen] = useState(false);
  const picked = useUI((s) => s.mdVersion);
  const history = useHistory(task, file, open || picked !== null);
  const list = history.data;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={cn('h-8 gap-1.5 px-2.5 text-[13px] font-normal text-ink-2', picked !== null && 'bg-muted font-bold text-foreground')} />}>
        <Icon name="history" size={15} />History
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[340px]">
        <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">{list === undefined ? (history.isError ? String(history.error.message) : 'Loading…') : list.length === 0 ? 'No history yet' : 'What changed, newest first'}</div>
        {list?.slice(0, LISTED).map((v, i) => (
          <DropdownMenuItem key={v.commit} className={cn('flex-col items-stretch gap-0.5 py-1.5', v.commit === picked && 'bg-muted')} onClick={() => useUI.setState({ mdVersion: v.commit })}>
            <span className="flex items-baseline gap-2 text-[13px] font-medium">
              {when(v.at)}
              {i === 0 ? <span className="text-[11.5px] font-normal text-brand">latest</span> : null}
              <span className="ml-auto font-mono text-[11.5px] font-normal">
                {v.add === null ? null : <><span className="text-success">{`+${v.add}`}</span>{' '}<span className="text-destructive">{`−${v.del}`}</span></>}
              </span>
            </span>
            <span className="truncate text-[12.5px] text-ink-3">{saidOf(v)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
