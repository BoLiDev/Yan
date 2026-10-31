import type { ReactNode } from 'react';
import { stateOf, type TaskDetail, type TaskState, type TaskSummary } from '../lib/api';
import { dayOf, fromIso } from '../lib/format';
import { link } from '../lib/route';
import { Icon } from '../components/Icon';
import { Notice, Paper, Scroll } from '../components/page';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { useKeyNav } from './nav';
import { Deliverables } from './overview/Deliverables';
import { Problem } from './overview/Problem';

/** Text with its web addresses as links. */
export function Linkified({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /https?:\/\/[^\s<>()（）「」，。；、]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    out.push(<a key={m.index} href={m[0]} target="_blank" rel="noopener">{m[0]}</a>);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

const STATE_WORD: Readonly<Record<TaskState, readonly ['brand' | 'warning' | 'success' | 'secondary', string]>> = { open: ['brand', 'In progress'], uat: ['warning', 'In review'], done: ['success', 'Done'], abandoned: ['secondary', 'Dropped'] };
/** The tags over a task's title, the first saying where it stands. */
const PILL = 'h-[26px] gap-1.5 rounded-full px-2.5 text-[12.5px] font-bold';

/** A task as a whole: where it stands, its problem and its deliverables. */
export function Overview({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  // A state this page does not know, a newer yan's, is named as task.json has it.
  const word = t.state === stateOf(t.state) ? STATE_WORD[stateOf(t.state)] : (['brand', t.state] as const);
  const dates = [t.id, t.createdAt ? `started ${dayOf(fromIso(t.createdAt))}` : null, t.closedAt ? `${t.state === 'done' ? 'done' : 'closed'} ${dayOf(fromIso(t.closedAt))}` : null].filter(Boolean).join(' · ');
  return (
    <Scroll>
      <Paper>
        <header className="mb-[34px] flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Badge variant={word[0]} className={PILL}>{word[1]}</Badge>
            <Badge variant="secondary" className={cn(PILL, 'font-normal text-ink-2')}>{dates}</Badge>
            {d.repos.map((repo, i) => (repo.branch
              ? <Badge key={i} variant="secondary" className={cn(PILL, 'font-normal text-ink-2 hover:text-foreground')} render={<a href={link.branch(t.id, i)} />}><Icon name="branch" size={13} />{`${repo.name} · ${repo.branch}`}</Badge>
              : <Badge key={i} variant="secondary" className={cn(PILL, 'font-normal text-ink-2')}>{repo.name}</Badge>))}
          </div>
          <h2 className="text-[30px] leading-[38px] tracking-[-0.02em] wrap-anywhere">{t.title || t.id}</h2>
        </header>
        {t.state === 'abandoned' && d.reason ? <Notice>{`Dropped: ${d.reason}`}</Notice> : null}
        <Problem t={t} d={d} />
        {d.deliverables.length ? <Deliverables t={t} d={d} /> : null}
      </Paper>
    </Scroll>
  );
}
