import { useMemo } from 'react';
import { stateOf, type Index, type TaskSummary } from '../lib/api';
import { MOD, clock, fromIso, monthLabel, plural } from '../lib/format';
import { link, useRoute } from '../lib/route';
import { latestUnseen, unseenOf, type Seen } from '../lib/seen';
import { Icon, StateIcon } from '../components/Icon';
import { Pane, PushTags, Tool } from '../components/ui';
import { UpdateCard } from '../components/Update';
import { canNotify, notifying, toggleNotify } from '../state/notify';
import { pullNow, useIndex } from '../state/server';
import { setPref, toggled, useUI } from '../state/ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

function Sync() {
  const st = useUI((s) => s.status);
  const connected = useUI((s) => s.connected);
  const pulling = useUI((s) => s.pulling);
  let cls = '';
  let head = 'Up to date';
  let sub = '';
  if (!connected) {
    cls = 'down';
    head = 'yan serve stopped';
    sub = "start it again with 'yan serve'";
  } else if (pulling) {
    cls = 'busy';
    head = 'Pulling…';
    sub = st?.checkedAt ? `checked ${clock(st.checkedAt, true)}` : '';
  } else if (st?.local) {
    head = 'Local vault';
    sub = 'no origin to pull from';
  } else if (st && !st.ok) {
    cls = 'warn';
    head = "Can't reach origin";
    sub = st.pulledAt ? `last pulled ${clock(st.pulledAt)}` : 'not pulled yet';
  } else if (st?.checkedAt) {
    sub = `checked ${clock(st.checkedAt, true)}`;
  }
  const every = st ? `Pulls every ${st.everyS} s by itself. ` : '';
  return (
    <button type="button" className={'sync' + (cls ? ' ' + cls : '')} aria-label="Pull now" title={(st?.error ? `${st.error}\n` : '') + every + 'Click to pull now.'} onClick={() => void pullNow()}>
      <span className="light" />
      <span className="words"><b>{head}</b><span>{sub}</span></span>
      <Icon name="refresh" size={16} />
    </button>
  );
}

function Bell() {
  useUI((s) => s.prefs.notify);
  if (!canNotify()) return null;
  if (Notification.permission === 'denied') {
    return <Tool name="bellOff" label="Chrome blocks notifications from this page. Allow them from the icon left of the address bar." onClick={() => void toggleNotify()} small blocked />;
  }
  const on = notifying();
  return <Tool name="bell" label={on ? 'Chrome says when a push arrives. Click to stop.' : 'Have Chrome say when a push arrives'} onClick={() => void toggleNotify()} small pressed={on} />;
}

function TaskRow({ t, index, seen, on }: { t: TaskSummary; index: Index; seen: Seen; on: boolean }) {
  const last = useUI((s) => s.last[t.id]);
  const fresh = on ? [] : [...unseenOf(index, seen, t.id).values()];
  return (
    <a className={'row' + (on ? ' on' : '')} href={last ?? link.task(t.id)} title={`${t.title || t.id} · ${t.id}`}>
      <StateIcon state={t.state} />
      <span className="grow">{t.title || t.id}</span>
      {fresh.length ? <span className="tags" title="since you last looked"><PushTags files={fresh} /></span> : null}
    </a>
  );
}

/**
 * A month of tasks done or given up, folded until it is clicked open, since
 * they pile up month on month and are rarely read again. Folded, it keeps in
 * view the task being read, and a dot says when one of its tasks has
 * something new, where nobody would otherwise see it.
 */
function MonthRows({ month, tasks, index, seen, openId }: { month: string; tasks: readonly TaskSummary[]; index: Index; seen: Seen; openId: string | null }) {
  const open = useUI((s) => s.months.includes(month));
  const shown = open ? tasks : tasks.filter((t) => t.id === openId);
  const fresh = !open && tasks.some((t) => t.id !== openId && unseenOf(index, seen, t.id).size > 0);
  return (
    <>
      <button type="button" className={'month' + (open ? ' open' : '')} aria-expanded={open}
        onClick={() => useUI.setState((s) => ({ months: toggled(s.months, month, !open) }))}>
        <span className="chev"><Icon name="chev" size={12} width={2.25} /></span>
        <span className="grow">{month}</span>
        {fresh ? <span className="dot" title="something new inside" /> : null}
        <span className="aside">{tasks.length}</span>
      </button>
      {shown.map((t) => <TaskRow key={t.id} t={t} index={index} seen={seen} on={t.id === openId} />)}
    </>
  );
}

export function Left() {
  const { data: index } = useIndex();
  const seen = useUI((s) => s.seen);
  const r = useRoute();
  const openId = r.view === 'task' ? r.id : null;

  const groups = useMemo(() => {
    if (!index) return [];
    const tasks = index.tasks;
    const byTouched = (a: TaskSummary, b: TaskSummary): number => b.touched - a.touched;
    const out: { label: string; rows: ({ t: TaskSummary } | { month: string; tasks: TaskSummary[] })[]; none?: string }[] = [];
    // Waiting on `user`, so above the rest; the group is not there when none is.
    const uat = tasks.filter((t) => t.state === 'uat').sort(byTouched);
    if (uat.length) out.push({ label: 'In review', rows: uat.map((t) => ({ t })) });
    // A state this page does not know, a newer yan's, is taken as open, so the task is never left out of every group.
    const open = tasks.filter((t) => stateOf(t.state) === 'open').sort(byTouched);
    out.push({ label: 'In progress', rows: open.map((t) => ({ t })), none: 'Nothing open' });
    const closed = tasks.filter((t) => t.state === 'done' || t.state === 'abandoned')
      .sort((a, b) => (fromIso(b.closedAt) || b.touched) - (fromIso(a.closedAt) || a.touched));
    const months: { month: string; tasks: TaskSummary[] }[] = [];
    for (const t of closed) {
      const m = monthLabel(fromIso(t.closedAt) || t.touched);
      if (months.at(-1)?.month !== m) months.push({ month: m, tasks: [] });
      (months.at(-1) as { tasks: TaskSummary[] }).tasks.push(t);
    }
    if (months.length) out.push({ label: 'Done', rows: months });
    return out;
  }, [index]);

  const onLatest = r.view === 'latest';
  const creating = useUI((s) => s.newTask);
  const unseen = index && seen ? latestUnseen(index, seen) : 0;
  const top = (
    <>
      <div className="brand">
        <b title={index ? `${index.vault.name} · ${index.vault.dir}` : undefined}>yan</b>
        <span className="grow" />
        <Tool name="panel" label="Hide the task list" onClick={() => setPref('left', false)} small />
      </div>
      <Sync />
      {/* Beside finding a task, starting one: a box asking what bare yan would, run in a new herdr tab. */}
      <div className="find-line">
        <button type="button" className="find" onClick={() => useUI.setState({ palette: true })}>
          <Icon name="search" size={15} />
          <span className="grow">Find a task</span>
          <kbd>{`${MOD}K`}</kbd>
        </button>
        <Button variant="secondary" size="icon-lg" className={cn('size-[34px] rounded-[10px] bg-hover text-ink-2 hover:bg-foreground/10 hover:text-foreground', creating && 'bg-foreground/10 text-foreground')} aria-label="New task" onClick={() => useUI.setState({ newTask: true })}><Icon name="plus" size={16} /></Button>
      </div>
      <div className={'latest-line' + (onLatest ? ' on' : '')}>
        <a className={'row' + (onLatest ? ' on' : '')} href="#/latest" style={{ fontWeight: 700 }}>
          <Icon name="latest" size={17} />
          <span className="grow">Latest</span>
          {unseen > 0 ? <Badge className="min-w-5 bg-brand px-1.5 font-bold text-white tabular-nums" title={`${plural(unseen, 'task')} with something new`}>{unseen}</Badge> : null}
        </a>
        <Bell />
      </div>
    </>
  );
  const body = !index || !seen ? null : (
    <div className="group" style={{ gap: '12px' }}>
      {groups.map((g) => (
        <div className="group" key={g.label}>
          <div className="label">{g.label}</div>
          {g.rows.length === 0 && g.none ? <div className="sublabel">{g.none}</div> : null}
          {g.rows.map((x) => ('month' in x
            ? <MonthRows key={`m:${x.month}`} month={x.month} tasks={x.tasks} index={index} seen={seen} openId={openId} />
            : <TaskRow key={x.t.id} t={x.t} index={index} seen={seen} on={x.t.id === openId} />))}
        </div>
      ))}
    </div>
  );
  return <nav className="left" aria-label="Tasks"><Pane top={top} body={body} foot={<UpdateCard />} /></nav>;
}
