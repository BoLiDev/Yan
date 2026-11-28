import { useParam } from './params';

/** PROTOTYPE: the bar that says this is one, what state it is in, and flips the one thing still being compared. Not part of the design. */
export function Switcher() {
  const [layout] = useParam('layout', 'agent');
  const [side, setSide] = useParam('details', 'right');
  if (import.meta.env.PROD) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[#111] py-1 pr-1 pl-3 font-mono text-[12px] whitespace-nowrap text-white shadow-[0_8px_30px_rgba(0,0,0,.45)] ring-2 ring-[#f5be3c]">
      <span><b className="text-[#f5be3c]">PROTOTYPE</b> · layout: {layout}</span>
      <button type="button" className="cursor-pointer rounded-full bg-white/15 px-2.5 py-1 hover:bg-white/25" onClick={() => setSide(side === 'right' ? 'left' : 'right')}>task column: {side} of the agent ⇄</button>
    </div>
  );
}
