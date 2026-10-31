import type { ReactNode } from 'react';

/**
 * A part of a task's overview: its heading, with a line about it and its
 * tools beside it, and what it holds under that.
 */
export function Section({ title, meta, tools, children }: { title: string; meta?: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-9 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h3 className="text-[17px]">{title}</h3>
        {meta === undefined ? null : <span className="text-[12.5px] text-ink-3">{meta}</span>}
        {tools}
      </div>
      {children}
    </section>
  );
}
