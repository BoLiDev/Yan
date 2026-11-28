import { useParam } from './params';

/** PROTOTYPE: the one thing still being compared. Not part of the design. */
export function Switcher() {
  const [side, setSide] = useParam('details', 'left');
  if (import.meta.env.PROD) return null;
  return (
    <button type="button" className="fixed right-3 bottom-3 z-[60] cursor-pointer rounded-full bg-[#111] px-3 py-1.5 font-mono text-[12px] whitespace-nowrap text-white opacity-80 shadow-[0_8px_30px_rgba(0,0,0,.45)] ring-2 ring-[#f5be3c] hover:opacity-100" onClick={() => setSide(side === 'right' ? 'left' : 'right')}>
      <b className="text-[#f5be3c]">PROTOTYPE</b> · task column: {side} of the agent ⇄
    </button>
  );
}
