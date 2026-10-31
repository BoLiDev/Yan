import type { ComponentProps, ReactNode } from 'react';
import { badge } from '../../lib/files';
import { cn } from '../../lib/utils';

/** Where a stage puts what it shows: in the middle; at the top, a text running down from it; a page filling it; a video at its top, a little closer to the edges. */
const AT = {
  middle: 'items-center',
  top: 'items-start',
  page: 'items-stretch p-[18px]',
  video: 'items-start p-6',
} as const;

/** Full screen, a picture is all there is: on near black, as large as the screen, with no corners or shadow. */
const FULL = [
  '[&:fullscreen]:bg-[#0d0d0c] [&:fullscreen]:p-0',
  '[&:fullscreen>img]:max-h-screen [&:fullscreen>img]:max-w-[100vw] [&:fullscreen>img]:rounded-none [&:fullscreen>img]:shadow-none',
].join(' ');

/**
 * What the right pane shows a file on, between the bar and the foot,
 * scrolling what is bigger than it. `dark` is the backdrop a picture can be
 * put on. The F key looks for it by `data-stage`.
 */
export function Stage({ at = 'middle', dark, className, ...props }: ComponentProps<'div'> & { at?: keyof typeof AT; dark?: boolean }) {
  return (
    <div data-stage="" {...props}
      className={cn('relative flex min-h-0 flex-auto justify-center overflow-auto p-7', dark ? 'bg-[var(--stage-dark)]' : 'bg-[var(--stage)]', AT[at], FULL, className)} />
  );
}

/** What is see-through in a picture shows squares behind it, so its edges can be told. */
const CHECKS = 'bg-[image:repeating-conic-gradient(var(--check-a)_0_25%,var(--check-b)_0_50%)] bg-[length:16px_16px]';

/**
 * A picture on its stage, whole, lifted off it by a shadow; on the dark
 * backdrop by a light edge and a deeper shadow. The F key puts it full
 * screen, finding it by `data-shot`.
 */
export function Shot({ dark, className, alt, ...props }: ComponentProps<'img'> & { dark?: boolean }) {
  return (
    <img data-shot="" alt={alt} {...props}
      className={cn('block max-h-full max-w-full rounded-[6px] object-contain', CHECKS,
        dark ? 'shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_12px_32px_rgba(0,0,0,0.5)]' : 'shadow-[0_0_0_1px_var(--shadow-line),0_12px_32px_var(--shadow-drop)]', className)} />
  );
}

/** A file the page does not draw, as a card: its kind large, its name, and under them what can be done with it. */
export function FileCard({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[16px] bg-card px-10 py-9 text-center ring-1 ring-border">
      <span className="rounded-[10px] bg-sunken px-3.5 py-2.5 font-mono text-[15px] leading-[normal] font-bold text-ink-2">{badge(name)}</span>
      <b>{name}</b>
      {children}
    </div>
  );
}
