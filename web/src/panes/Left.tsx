import { useMemo } from 'react';
import { stateOf, type Index, type TaskSummary } from '../lib/api';
import { MOD, clock, fromIso, monthLabel, plural } from '../lib/format';
import { link, useRoute } from '../lib/route';
import { latestUnseen, unseenOf, type Seen } from '../lib/seen';
import { Icon, StateIcon } from '../components/Icon';
import { Dot, GROW, LABEL, Pane, PushTags, SUBLABEL, Tool, row } from '../components/page';
import { Kbd } from '../components/ui/kbd';
import { UpdateCard } from '../components/Update';
import { canNotify, notifying, toggleNotify } from '../state/notify';
import { pullNow, useIndex } from '../state/server';
import { setPref, toggled, useUI } from '../state/ui';
import { Badge } from '../components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { useTheme } from '../state/theme';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';

/** The light beside what serve says of the vault: green, teal while pulling, amber when origin is out of reach, red when serve is gone. */
const LIGHT = {
  ok: 'bg-success ring-3 ring-success-soft',
  busy: 'animate-pulse bg-brand ring-3 ring-brand-soft',
  warn: 'bg-warning ring-3 ring-warning-soft',
  down: 'bg-destructive ring-3 ring-danger-soft',
} as const;

function Sync() {
  const st = useUI((s) => s.status);
  const connected = useUI((s) => s.connected);
  const pulling = useUI((s) => s.pulling);
  let tone: keyof typeof LIGHT = 'ok';
  let head = 'Up to date';
  let sub = '';
  if (!connected) {
    tone = 'down';
    head = 'yan serve stopped';
    sub = "start it again with 'yan serve'";
  } else if (pulling) {
    tone = 'busy';
    head = 'Pulling…';
    sub = st?.checkedAt ? `checked ${clock(st.checkedAt, true)}` : '';
  } else if (st?.local) {
    head = 'Local vault';
    sub = 'no origin to pull from';
  } else if (st && !st.ok) {
    tone = 'warn';
    head = "Can't reach origin";
    sub = st.pulledAt ? `last pulled ${clock(st.pulledAt)}` : 'not pulled yet';
  } else if (st?.checkedAt) {
    sub = `checked ${clock(st.checkedAt, true)}`;
  }
  const every = st ? `Pulls every ${st.everyS} s by itself. ` : '';
  return (
    <button type="button" className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl bg-card px-3 py-2 text-left" aria-label="Pull now"
      title={(st?.error ? `${st.error}\n` : '') + every + 'Click to pull now.'} onClick={() => void pullNow()}>
      <span className={cn('size-2 flex-none rounded-full', LIGHT[tone])} />
      <span className="flex min-w-0 flex-1 flex-col leading-[17px]">
        <b className="text-[13px]">{head}</b>
        <span className="truncate text-xs/[17px] text-ink-3">{sub}</span>
      </span>
      <Icon name="refresh" size={16} className={cn('text-ink-3', tone === 'busy' && 'animate-spin')} />
    </button>
  );
}

/** Which theme the page is drawn in: the browser's, or light or dark whatever it says. */
function ThemeMenu() {
  const theme = useUI((s) => s.prefs.theme);
  const now = useTheme();
  const choices = [['system', 'As the browser', 'system'], ['light', 'Light', 'light'], ['dark', 'Dark', 'night']] as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-ink-3 hover:text-foreground" aria-label="Theme" title="Theme" />}>
        <Icon name={now === 'dark' ? 'night' : 'light'} size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setPref('theme', v as typeof theme)}>
          {choices.map(([value, label, icon]) => (
            <DropdownMenuRadioItem key={value} value={value} closeOnClick><Icon name={icon} size={15} />{label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <a className={row({ on })} aria-current={on ? 'page' : undefined} href={last ?? link.task(t.id)} title={`${t.title || t.id} · ${t.id}`}>
      <StateIcon state={t.state} />
      <span className={GROW}>{t.title || t.id}</span>
      {fresh.length ? <span className="flex flex-none gap-1" title="since you last looked"><PushTags files={fresh} /></span> : null}
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
      {/* A sublabel that folds the tasks under it; its chevron sits where a task's icon does. */}
      <button type="button" aria-expanded={open}
        className="flex min-h-7 w-full cursor-pointer items-center text-left gap-2 rounded-lg pt-1 pr-2.5 pb-0.5 pl-3 text-[12px] text-ink-3 hover:bg-hover hover:text-ink-2 focus-visible:-outline-offset-2"
        onClick={() => useUI.setState((s) => ({ months: toggled(s.months, month, !open) }))}>
        <span className={cn('flex flex-none transition-transform duration-100', open && 'rotate-90')}><Icon name="chev" size={12} width={2.25} /></span>
        <span className={GROW}>{month}</span>
        {fresh ? <Dot title="something new inside" /> : null}
        <span className="flex-none tabular-nums">{tasks.length}</span>
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
  // Hidden, it stays drawn, its scroll and folds kept for when it is shown again.
  const shown = useUI((s) => s.prefs.left);
  const creating = useUI((s) => s.newTask);
  const unseen = index && seen ? latestUnseen(index, seen) : 0;
  const top = (
    <>
      <div className="flex items-center gap-2 py-0.5 pr-0.5 pl-2.5">
        <b className="text-[22px] tracking-tight" title={index ? `${index.vault.name} · ${index.vault.dir}` : undefined}>yan</b>
        <span className="flex-1" />
        <ThemeMenu />
        <Tool name="panel" label="Hide the task list" onClick={() => setPref('left', false)} small />
      </div>
      <Sync />
      {/* Beside finding a task, starting one: a box asking what bare yan would, run in a new herdr tab. */}
      <div className="flex gap-1.5">
        {/* The task list's way into ⌘K, drawn as the box it opens. */}
        <button type="button" className="flex h-[34px] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[10px] bg-hover pr-2 pl-2.5 text-[13.5px] text-ink-3 hover:text-ink-2"
          onClick={() => useUI.setState({ palette: true })}>
          <Icon name="search" size={15} />
          <span className={cn(GROW, 'text-left')}>Find a task</span>
          <Kbd>{`${MOD}K`}</Kbd>
        </button>
        <Button variant="secondary" size="icon-lg" className={cn('size-[34px] rounded-[10px] bg-hover text-ink-2 hover:bg-foreground/10 hover:text-foreground', creating && 'bg-foreground/10 text-foreground')} aria-label="New task" onClick={() => useUI.setState({ newTask: true })}><Icon name="plus" size={16} /></Button>
      </div>
      {/* The Latest line is the card, so the bell sits inside it: a button cannot sit inside the row's link. */}
      <div className={cn('flex items-center gap-0.5 rounded-[10px] pr-1', onLatest ? 'bg-card ring-1 ring-border' : 'has-[>a:hover]:bg-hover')}>
        <a className={cn(row(), 'min-w-0 flex-1 font-bold hover:bg-transparent')} aria-current={onLatest ? 'page' : undefined} href="#/latest">
          <Icon name="latest" size={17} />
          <span className={GROW}>Latest</span>
          {unseen > 0 ? <Badge className="min-w-5 bg-brand px-1.5 font-bold text-white tabular-nums" title={`${plural(unseen, 'task')} with something new`}>{unseen}</Badge> : null}
        </a>
        <Bell />
      </div>
    </>
  );
  const body = !index || !seen ? null : (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <div className="flex flex-col gap-px" key={g.label}>
          <div className={LABEL}>{g.label}</div>
          {g.rows.length === 0 && g.none ? <div className={SUBLABEL}>{g.none}</div> : null}
          {g.rows.map((x) => ('month' in x
            ? <MonthRows key={`m:${x.month}`} month={x.month} tasks={x.tasks} index={index} seen={seen} openId={openId} />
            : <TaskRow key={x.t.id} t={x.t} index={index} seen={seen} on={x.t.id === openId} />))}
        </div>
      ))}
    </div>
  );
  return (
    <nav className={cn('flex h-screen w-60 flex-none flex-col overflow-hidden bg-sunken max-[1100px]:w-[220px]', !shown && 'hidden')} aria-label="Tasks">
      <Pane tight top={top} body={body} foot={<UpdateCard />} />
    </nav>
  );
}
