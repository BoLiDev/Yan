import type { ReactNode } from 'react';
import { baseName, dirName } from '../../lib/files';
import { cn } from '../../lib/utils';
import { Tool } from './Tool';

/**
 * The right pane's toolbar: what is shown, a line about it, and the tools for
 * it. `flush` drops the line under it, over what is drawn edge to edge, as a
 * terminal is.
 */
export function Bar({ title, meta, tools, flush }: { title: ReactNode; meta?: ReactNode; tools?: ReactNode; flush?: boolean }) {
  return (
    <div className={cn('flex min-h-14 flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b py-2 pr-3.5 pl-5', flush ? 'border-transparent' : 'border-sunken')}>
      <div className="flex min-w-0 flex-[1_1_240px] flex-col leading-[19px]">
        <span className="truncate text-[15px] font-bold">{title}</span>
        <span className="truncate text-[12px] text-ink-3 tabular-nums">{meta ?? ''}</span>
      </div>
      {tools}
    </div>
  );
}

/** A path as the bar names it: its folder dim before its name. */
export function Crumb({ path }: { path: string }) {
  const dir = dirName(path);
  return <>{dir ? <span className="font-normal text-ink-3">{dir} / </span> : null}{baseName(path)}</>;
}

/** Tools that go together in a bar. */
export function BarTools({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

/** A line between groups of tools. */
export function BarSep() {
  return <span className="h-[22px] w-px bg-border" />;
}

/**
 * ← and → through a list, with where in it this is between them: the files
 * of a task, the commits of a branch. `what` names what is stepped through.
 */
export function Stepper({ prev, next, pos, total, what }: { prev: string | null; next: string | null; pos: number; total: number; what?: string }) {
  const of = what ? ` ${what}` : '';
  return (
    <BarTools>
      <Tool name="prev" label={`Previous${of} (←)`} href={prev} newTab={false} disabled={!prev} />
      <span className="min-w-[58px] text-center text-[13px] text-ink-2 tabular-nums">{total ? `${pos} / ${total}` : ''}</span>
      <Tool name="next" label={`Next${of} (→)`} href={next} newTab={false} disabled={!next} />
    </BarTools>
  );
}
