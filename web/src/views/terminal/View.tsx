import { useEffect, useRef, useState } from 'react';
import type { Layout, TerminalState, WorktreeState } from '../../lib/api';
import { link } from '../../lib/route';
import { usePageKeys } from '../../lib/modal';
import { tilesOf } from '../../lib/tiles';
import { Icon } from '../../components/Icon';
import { Empty } from '../../components/page';
import { useWorktrees } from '../../state/server';
import { useUI } from '../../state/ui';
import { useKeyNav } from '../nav';
import { ContinueButton } from './controls';
import { PaneTerm } from './PaneTerm';
import { AGENT, TabBar } from './TabBar';
import { Tiles } from './Tiles';
import { reshape, send } from './transport';
import type { Panes } from './usePaneTerm';

const NONE: readonly WorktreeState[] = [];

/**
 * A task's terminal, as herdr streams its panes: the bytes each program
 * draws, drawn by xterm.js, so what is here is what is in the terminal,
 * the agent's questions, menus and completions with it. Its tabs are the
 * agent's own, and one for each worktree MR's page opened, a shell in it;
 * each is split as herdr has it, the agent and any shell split off beside
 * it, in herdr or here: a right click on a pane splits it, copies, pastes,
 * or closes a shell, never the agent's own pane.
 *
 * `over` says the task is closed and serve has said which terminals there
 * are: one not there will not come back, serve having closed it once the
 * agent's closing went through, so the page goes on to the task's overview,
 * in place of where it was.
 */
export function TerminalView({ id, state, waiting = false, goesOn = false, over = false }: { id: string; state: TerminalState | undefined; waiting?: boolean; goesOn?: boolean; over?: boolean }) {
  useKeyNav(null, null);
  const worktrees = useWorktrees().data?.[id] ?? NONE;
  const picked = useUI((s) => s.termTab[id]);
  const worktree = worktrees.find((w) => w.tab === picked);
  const tab = worktree?.tab ?? AGENT;
  const gone = over && !state && worktrees.length === 0;
  useEffect(() => {
    if (gone) location.replace(link.task(id));
  }, [gone, id]);
  // Gone on with from here, the task's terminal is the dark stage until herdr lists the new tab's pane.
  const [starting, setStarting] = useState(false);
  // Listed, it is no longer starting: put so as it is drawn, not after, so a stop later shows Continue again.
  if (state && starting) setStarting(false);
  // The panes' terminals, read in effects and handlers only: none of it is drawn.
  const panes = useRef<Panes>({ terms: new Map(), last: undefined, next: undefined });
  const shown: { layout: Layout; agentPane: string | null; streams: boolean; herdr: string } | undefined = worktree
    ? { layout: worktree.layout, agentPane: null, streams: worktree.streams, herdr: worktree.herdr }
    : state ? { layout: state.layout ?? { pane: state.pane }, agentPane: state.pane, streams: state.streams, herdr: state.herdr } : undefined;

  // Enter on the page, nothing else taking it, puts the keys in the terminal typed in last, as a click on it does.
  usePageKeys((e) => {
    const active = document.activeElement;
    if (e.key !== 'Enter' || /^(BUTTON|A)$/.test(active?.tagName ?? '') || active?.getAttribute('role') === 'tab') return false;
    const p = panes.current;
    const term = p.terms.get(p.last ?? '') ?? p.terms.get(shown === undefined ? '' : tilesOf(shown.layout)[0]?.pane ?? '');
    term?.focus();
    return term !== undefined;
  });

  // The strip holds the tabs, and Continue where the agent's would be while none runs; the tab shown is drawn as what is under it, dark or the page.
  const bar = (
    <TabBar id={id} on={tab} agent={!!state && !waiting} worktrees={worktrees} dark={shown?.streams ?? (waiting || starting)}
      tools={tab === AGENT && !state && !waiting && !starting && goesOn ? <ContinueButton id={id} starting={setStarting} /> : null} />
  );
  // A new task's tab, opened a moment ago, is a dark terminal until herdr lists its pane.
  if (shown === undefined && (waiting || starting)) return <>{bar}<Tiles /></>;
  if (shown === undefined) {
    return (
      <>
        {bar}
        {/* A task with no terminal: a terminal, large, and nothing to read. */}
        <div className="flex flex-auto items-center justify-center p-10">
          <Icon name="terminal" size={256} width={0.4} className="text-ink-4" />
        </div>
      </>
    );
  }
  return (
    <>
      {bar}
      {shown.streams ? (
        <Tiles>
          {tilesOf(shown.layout).map((tile) => (
            <PaneTerm key={tile.pane} task={id} tile={tile} agent={tile.pane === shown.agentPane} panes={panes}
              split={(direction) => void reshape('split', { task: id, pane: tile.pane, direction }).then((made) => {
                panes.current.next = made?.pane;
              })}
              paste={(text) => send(id, tile.pane, { paste: text, enter: false })}
              close={() => void reshape('close', { task: id, pane: tile.pane })} />
          ))}
        </Tiles>
      ) : (
        <Empty title="herdr is too old">{`herdr on this machine is ${shown.herdr || 'a version it does not say'}; showing its panes here takes 0.7.2 or newer (the latest stable is best). Run herdr update.`}</Empty>
      )}
    </>
  );
}
