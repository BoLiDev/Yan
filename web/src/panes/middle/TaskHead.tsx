import type { ReactNode } from 'react';

/**
 * A task's title at the head of its column, after the icon that stands for
 * its state, set down a little to sit on the title's first line, and after
 * it `more`, the mark that opens what yan keeps of the task itself.
 */
export function TaskHead({ icon, title, more }: { icon: ReactNode; title: string; more?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 px-2.5 [&>svg]:mt-1">
      {icon}
      <h1 className="min-w-0 flex-1 text-[19px]/[26px] font-bold tracking-[-0.01em] wrap-anywhere">{title}</h1>
      {more}
    </div>
  );
}
