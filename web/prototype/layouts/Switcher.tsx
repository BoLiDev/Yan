import { useParam } from './params';

const PLACES = ['head', 'row', 'foot', 'title'] as const;
const SAYS = { head: "in the task list's head", row: 'a row of its own in the task list', foot: 'at the foot of the task list', title: "on the task's title" } as const;

/** PROTOTYPE: the bar that says this is one, and flips the two things still being compared. Not part of the design. */
export function Switcher() {
  const [side, setSide] = useParam('details', 'left');
  const [place, setPlace] = useParam('switch', 'row');
  if (import.meta.env.PROD) return null;
  const at = Math.max(0, PLACES.indexOf(place as (typeof PLACES)[number]));
  const pill = 'cursor-pointer rounded-full bg-white/15 px-2.5 py-1 hover:bg-white/25';
  return (
    <div className="fixed right-3 bottom-3 z-50 flex flex-col items-end gap-1 rounded-[14px] bg-[#111] p-1.5 font-mono text-[12px] whitespace-nowrap text-white opacity-90 shadow-[0_8px_30px_rgba(0,0,0,.45)] ring-2 ring-[#f5be3c] hover:opacity-100">
      <b className="px-1.5 text-[#f5be3c]">PROTOTYPE</b>
      <button type="button" className={pill} onClick={() => setPlace(PLACES[(at + 1) % PLACES.length] as string)}>switch {at + 1}/{PLACES.length}: {SAYS[PLACES[at] as keyof typeof SAYS]} ⇄</button>
      <button type="button" className={pill} onClick={() => setSide(side === 'right' ? 'left' : 'right')}>task column: {side} of the agent ⇄</button>
    </div>
  );
}
