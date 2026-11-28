import { useEffect } from 'react';
import { Icon } from '@/components/Icon';
import { setParams, useParam } from './params';

export const VARIANTS = [
  ['A', 'Two named layouts, a switch on the task'],
  ['B', 'One layout, the file pane opens and closes'],
  ['C', 'A top bar, the path across it'],
] as const;

/** PROTOTYPE: the bar that flips between variants. Not part of any design. */
export function Switcher({ current }: { current: string }) {
  const [layout] = useParam('layout', '');
  const [file] = useParam('file', '');
  const at = VARIANTS.findIndex(([k]) => k === current);
  const step = (by: number): void => {
    const to = VARIANTS[(at + by + VARIANTS.length) % VARIANTS.length] as (typeof VARIANTS)[number];
    setParams({ variant: to[0], layout: null, file: null });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  if (import.meta.env.PROD) return null;
  const state = [layout && `layout: ${layout}`, file && `file: ${file}`].filter(Boolean).join(' · ');
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#111] py-1 pr-1 pl-1 font-mono text-[12px] text-white shadow-[0_8px_30px_rgba(0,0,0,.45)] ring-2 ring-[#f5be3c]">
      <button type="button" aria-label="Previous variant" className="flex size-7 cursor-pointer items-center justify-center rounded-full hover:bg-white/15" onClick={() => step(-1)}><Icon name="prev" size={15} /></button>
      <span className="px-1.5 whitespace-nowrap"><b className="text-[#f5be3c]">PROTOTYPE {current}</b> · {VARIANTS[at]?.[1]}{state ? <span className="text-white/60"> · {state}</span> : null}</span>
      <button type="button" aria-label="Next variant" className="flex size-7 cursor-pointer items-center justify-center rounded-full hover:bg-white/15" onClick={() => step(1)}><Icon name="next" size={15} /></button>
    </div>
  );
}
