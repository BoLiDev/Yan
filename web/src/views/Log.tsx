import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import type { LogEntry, TaskDetail, TaskSummary } from '../lib/api';
import { fromIso, monthName, nowS, plural, sameDay, when } from '../lib/format';
import { Bar, Empty } from '../components/ui';
import { setSeen, useUI } from '../state/ui';
import { useKeyNav } from './nav';
import { Linkified } from './Overview';

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
      rows.push(<div className="log-day" key={`day:${e.day}:${i}`}>{today ? `Today · ${label}` : label}</div>);
    }
    rows.push(
      <div className={'log-entry' + (i >= before ? ' fresh' : '')} key={i}>
        <span className={`log-type ${e.type}`}>{e.type}</span>
        <span className="txt"><Linkified text={e.text} /></span>
      </div>,
    );
  }
  return (
    <>
      <Bar title="Log" meta={`${plural(n, 'entry', 'entries')}, newest first · log.md${d.log?.changed ? ` · written ${when(d.log.changed)}` : ''}`} />
      <div className="scroll"><div className="paper">{n ? rows : <Empty>No log yet.</Empty>}</div></div>
    </>
  );
}
