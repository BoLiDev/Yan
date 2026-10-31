import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import type { LogEntry, TaskDetail, TaskSummary } from '../lib/api';
import { fromIso, monthName, nowS, plural, sameDay, when } from '../lib/format';
import { cn } from '../lib/utils';
import { Bar, Empty, Paper, Scroll } from '../components/page';
import { setSeen, useUI } from '../state/ui';
import { useKeyNav } from './nav';
import { Linkified } from './Overview';

/** An entry's type as a tag: what was agreed in the brand's colour, what changed in amber, the rest grey. */
function typeLook(type: string): string {
  if (type === 'agreed') return 'bg-brand-soft text-brand';
  if (type === 'changed') return 'bg-warning-soft text-warning';
  return 'bg-sunken text-ink-3';
}

/**
 * The log, newest first, a day at a time. What was new as the visit began
 * stays tinted until it ends; reading it marks it read, so its dot goes.
 */
export function LogView({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  const entries = d.log?.entries ?? [];
  const n = entries.length;
  // Read before it is marked: the tint starts from what came before the visit. Opening the log reads it;
  // entries that arrive while it is open wait for a click in it, as a changed file does.
  const before = useUI((s) => s.logBase[t.id] ?? s.seen?.logs[t.id] ?? n);
  // Only on opening, with the entries there then: what arrives later is read by a click in the pane.
  const opened = useEffectEvent(() => {
    const s = useUI.getState();
    if (!(t.id in s.logBase)) useUI.setState({ logBase: { ...s.logBase, [t.id]: s.seen?.logs[t.id] ?? n } });
    setSeen((seen) => (seen.logs[t.id] === n ? null : { ...seen, logs: { ...seen.logs, [t.id]: n } }));
  });
  useEffect(() => opened(), [t.id]);
  // Today as the log was opened, for the day it names as today.
  const [now] = useState(() => new Date());

  const year = new Date((fromIso(t.createdAt) || nowS()) * 1000).getFullYear();
  const rows: ReactNode[] = [];
  let day = '';
  for (let i = n - 1; i >= 0; i--) {
    const e = entries[i] as LogEntry;
    if (e.day !== day) {
      day = e.day;
      const [mm = 0, dd = 0] = e.day.split('-').map(Number);
      const label = `${monthName(mm - 1)} ${dd}`;
      const today = sameDay(new Date(year, mm - 1, dd), now);
      rows.push(<div className="mt-[22px] mb-2 text-[12.5px] font-bold text-ink-3 first:mt-0" key={`day:${e.day}:${i}`}>{today ? `Today · ${label}` : label}</div>);
    }
    rows.push(
      <div className={cn('-mx-3 grid grid-cols-[74px_minmax(0,1fr)] gap-3 rounded-[10px] px-3 py-2 text-[14.5px] leading-6', i >= before && 'bg-brand-wash')} key={i}>
        <span className={cn('mt-0.5 h-5 self-start rounded-full px-2 text-center text-[12px] leading-5', typeLook(e.type))}>{e.type}</span>
        <span className="whitespace-pre-wrap wrap-anywhere"><Linkified text={e.text} /></span>
      </div>,
    );
  }
  return (
    <>
      <Bar title="Log" meta={`${plural(n, 'entry', 'entries')}, newest first · log.md${d.log?.changed ? ` · written ${when(d.log.changed)}` : ''}`} />
      <Scroll><Paper>{n ? rows : <Empty>No log yet.</Empty>}</Paper></Scroll>
    </>
  );
}
