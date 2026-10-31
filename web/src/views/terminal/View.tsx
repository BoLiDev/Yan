import { useRef, useState } from 'react';
import type { TerminalState } from '../../lib/api';
import { usePageKeys } from '../../lib/modal';
import { tilesOf } from '../../lib/tiles';
import { Icon } from '../../components/Icon';
import { Bar, Empty } from '../../components/page';
import { useKeyNav } from '../nav';
import { ContinueButton, StopButton } from './controls';
import { PaneTerm } from './PaneTerm';
import { Tiles, Waiting } from './Tiles';
import { reshape, send } from './transport';
import type { Panes } from './usePaneTerm';

/**
 * The agent's tab, as herdr streams its panes: the bytes each program
 * draws, drawn by xterm.js, so what is here is what is in the terminal,
 * the agent's questions, menus and completions with it. The tab is split
 * as herdr has it, the agent and any shell split off beside it, in herdr or
 * here: a right click on a pane splits it, copies, pastes, or closes a shell.
 */
export function TerminalView({ id, state, waiting = false, goesOn = false }: { id: string; state: TerminalState | undefined; waiting?: boolean; goesOn?: boolean }) {
  useKeyNav(null, null);
  // Gone on with from here, the task's terminal is the dark stage until herdr lists the new tab's pane.
  const [starting, setStarting] = useState(false);
  // Listed, it is no longer starting: put so as it is drawn, not after, so a stop later shows Continue again.
  if (state && starting) setStarting(false);
  // The panes' terminals, read in effects and handlers only: none of it is drawn.
  const panes = useRef<Panes>({ terms: new Map(), last: undefined, next: undefined });

  // Enter on the page, nothing else taking it, puts the keys in the terminal typed in last, as a click on it does.
  usePageKeys((e) => {
    const active = document.activeElement;
    if (e.key !== 'Enter' || /^(BUTTON|A)$/.test(active?.tagName ?? '')) return false;
    const p = panes.current;
    const term = p.terms.get(p.last ?? '') ?? p.terms.get(state?.pane ?? '');
    term?.focus();
    return term !== undefined;
  });

  // A new task's tab, opened a moment ago, is a dark terminal until herdr lists its pane.
  if (!state && (waiting || starting)) return <Waiting />;
  if (!state) {
    return (
      <>
        {/* Continue is where Stop is while one runs: the bar's own way to start or stop it. */}
        <Bar title="Terminal" meta="" tools={goesOn ? <ContinueButton id={id} starting={setStarting} /> : null} />
        {/* A task with no terminal: a terminal, large, and nothing to read. */}
        <div className="flex flex-auto items-center justify-center p-10">
          <Icon name="terminal" size={256} width={0.4} className="text-ink-4" />
        </div>
      </>
    );
  }
  const tiles = tilesOf(state.layout ?? { pane: state.pane });
  return (
    <>
      {/* What the agent is doing is the Terminal row's to say, and the terminal's own: the bar holds only Stop. Over
          the dark tab, it has no line of its own. */}
      <Bar title="Terminal" meta="" flush={state.streams} tools={waiting ? null : <StopButton id={id} />} />
      {state.streams ? (
        <Tiles>
          {tiles.map((tile) => (
            <PaneTerm key={tile.pane} task={id} tile={tile} agent={tile.pane === state.pane} panes={panes}
              split={(direction) => void reshape('split', { task: id, pane: tile.pane, direction }).then((made) => {
                panes.current.next = made?.pane;
              })}
              paste={(text) => send(id, tile.pane, { paste: text, enter: false })}
              close={() => void reshape('close', { task: id, pane: tile.pane })} />
          ))}
        </Tiles>
      ) : (
        <Empty title="herdr is too old">{`herdr on this machine is ${state.herdr || 'a version it does not say'}; showing its panes here takes 0.7.2 or newer (the latest stable is best). Run herdr update.`}</Empty>
      )}
    </>
  );
}
