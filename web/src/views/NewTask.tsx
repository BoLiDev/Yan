import { useEffect } from 'react';
import type { Index, TerminalState } from '../lib/api';
import { link } from '../lib/route';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui/spinner';
import { Pane } from '../components/page';
import { pullNow } from '../state/server';
import { useUI } from '../state/ui';
import { TerminalView } from './TerminalLazy';
import { useKeyNav } from './nav';

/**
 * A new task as it is made, in the middle column: its title, a turning ring
 * where its state will be, and the repositories it was given, each with the
 * packages it is about, as its own page will list them once it is there.
 */
export function LaunchHead({ launch, state }: { launch: string; state: TerminalState | undefined }) {
  const given = useUI((s) => s.launched[launch]);
  const title = given?.title ?? state?.title ?? '';
  const top = (
    <div className="task-head">
      <div className="t"><Spinner className="size-[18px] text-brand" /><h1>{title}</h1></div>
    </div>
  );
  const body = given !== undefined && given.repos.length > 0 ? (
    <div className="nav launch-repos">
      {given.repos.map((r) => (
        <div key={r.name} className="row">
          <Icon name="branch" size={16} />
          <span className="grow">{r.name}</span>
          {r.scope.length > 0 ? <span className="aside">{r.scope.join(' · ')}</span> : null}
        </div>
      ))}
    </div>
  ) : null;
  return <Pane top={top} body={body} />;
}

/**
 * A new task's terminal: its herdr tab, bare `yan` making the task and its
 * trees, then the agent. Once bare `yan` keeps the pane as the task's and the
 * task, pushed, is in the index, the page is the task's own Terminal, the
 * same pane.
 */
export function LaunchView({ launch, state, index }: { launch: string | undefined; state: TerminalState | undefined; index: Index }) {
  useKeyNav(null, null);
  const task = state?.task;
  const listed = task !== undefined && index.tasks.some((t) => t.id === task);
  useEffect(() => {
    if (task !== undefined && listed) location.replace(link.terminal(task));
  }, [task, listed]);
  // bare yan pushes the task it made before the agent starts; serve is asked to fetch it until it shows it.
  useEffect(() => {
    if (task === undefined || listed) return;
    void pullNow();
    const again = window.setInterval(() => void pullNow(), 3000);
    return () => window.clearInterval(again);
  }, [task, listed]);
  if (launch === undefined) return null;
  return <TerminalView id={launch} state={state} waiting />;
}
