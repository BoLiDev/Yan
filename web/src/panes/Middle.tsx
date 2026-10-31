import { useLayoutEffect, type ReactNode } from 'react';
import { useHash, useRoute } from '../lib/route';
import { Empty } from '../components/page';
import { useIndex, useTerminals } from '../state/server';
import { LaunchHead } from '../views/NewTask';
import { useUI } from '../state/ui';
import { Feed } from './middle/Feed';
import { TaskIndex } from './middle/TaskIndex';

/** The middle column: a task's title, nav and artifacts, what arrived in Latest, or a new task as it is made. */
export function Middle() {
  const r = useRoute();
  const { data: index } = useIndex();
  const seen = useUI((s) => s.seen);
  const hash = useHash();

  // The row of what is being shown, kept in view when the route moves to it.
  useLayoutEffect(() => {
    const scroller = document.querySelector<HTMLElement>('#middle [data-scroll]');
    const on = scroller?.querySelector('[aria-current]');
    if (!scroller || !on) return;
    const a = on.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    if (a.top < b.top || a.bottom > b.bottom) on.scrollIntoView({ block: 'center' });
  }, [hash]);

  const { data: terminals } = useTerminals();
  let inner: ReactNode = null;
  if (index && seen) {
    if (r.view === 'new') inner = r.launch === undefined ? null : <LaunchHead launch={r.launch} state={terminals?.[r.launch]} />;
    else if (r.view === 'latest') inner = <Feed index={index} seen={seen} r={r} />;
    else {
      const t = index.tasks.find((x) => x.id === r.id);
      inner = t ? <TaskIndex key={t.id} t={t} r={r} index={index} seen={seen} /> : <Empty title={`No ${r.id} here`}>{`The vault ${index.vault.name} has no task called ${r.id}.`}</Empty>;
    }
  }
  return <aside id="middle" aria-label={r.view === 'latest' ? 'Latest' : 'Task'} className="flex h-screen w-[312px] flex-none flex-col overflow-hidden border-r max-[1100px]:w-[280px]">{inner}</aside>;
}
