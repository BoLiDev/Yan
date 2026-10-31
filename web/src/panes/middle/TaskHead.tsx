import type { ReactNode } from 'react';

/**
 * A task's title at the head of its column, after the icon that stands for
 * its state, set down a little to sit on the title's first line.
 */
export function TaskHead({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-start gap-2.5 px-2.5 [&_svg]:mt-1">
      {icon}
      <h1 className="text-[19px]/[26px] font-bold tracking-[-0.01em] wrap-anywhere">{title}</h1>
    </div>
  );
}
