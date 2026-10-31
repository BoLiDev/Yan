import type { BranchCommit } from '../../lib/api';
import { dayOf, short } from '../../lib/format';
import { inBranch, type BranchRoute } from '../../lib/route';
import { ASIDE } from '../../components/page';
import { cn } from '../../lib/utils';

const STATUS_WORD: Record<string, string> = { A: 'added', D: 'deleted', R: 'renamed', M: 'changed', C: 'copied', T: 'type changed' };
/** A change's letter in the colour of what it did; a change in place says none, and the rest are grey. */
const STATUS_INK: Record<string, string> = { A: 'text-success', D: 'text-destructive', R: 'text-brand' };
/** A change's lines added and deleted, in code, never bold even on the row being shown. */
const COUNT = 'font-mono text-[11.5px] leading-[normal] font-normal';

/** Where a changed file's icon would be: what became of it, as git's letter. */
export function StatusLetter({ status }: { status: string }) {
  return (
    <span className={cn('w-4 flex-none text-center font-mono text-[11px] leading-[normal] font-bold text-ink-3', STATUS_INK[status])} title={STATUS_WORD[status] ?? ''}>
      {status === 'M' ? '' : status}
    </span>
  );
}

/** At a changed file's end, the lines it added and deleted, or that it is binary. */
export function Counts({ add, del }: { add: number | null; del: number | null }) {
  if (add === null) return <span className={ASIDE}>binary</span>;
  return (
    <>
      <span className={cn(COUNT, 'text-success')}>{add ? `+${add}` : ''}</span>
      <span className={cn(COUNT, 'min-w-[26px] text-destructive')}>{del ? `−${del}` : ''}</span>
    </>
  );
}

/** A branch's commits, newest first, the one being shown a card; its subject wraps whole rather than giving way. */
export function Commits({ r, commits }: { r: BranchRoute; commits: readonly BranchCommit[] }) {
  const shown = r.item || commits[0]?.sha;
  return (
    <>
      {commits.map((c) => {
        const on = shown === c.sha;
        return (
          <a key={c.sha} href={inBranch(r, 'commits', c.sha)} aria-current={on ? 'page' : undefined}
            className={cn('flex items-baseline gap-3 rounded-md px-2.5 py-[7px] text-[13.5px] text-foreground no-underline hover:bg-hover hover:text-foreground', on && 'bg-card ring-1 ring-border hover:bg-card')}>
            <span className="flex-none font-mono text-[12px] text-brand">{short(c.sha)}</span>
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-normal wrap-anywhere">{c.subject}</span>
            <span className="flex-none text-[12px] whitespace-nowrap text-ink-3">{dayOf(c.at)}</span>
          </a>
        );
      })}
    </>
  );
}
