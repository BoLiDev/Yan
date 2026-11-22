import { useMemo } from 'react';
import { JANUS, stateOf, works, type Index, type TaskSummary } from '../lib/api';
import { MOD, clock, fromIso, monthLabel } from '../lib/format';
import { link, useRoute } from '../lib/route';
import { agentNews, agentWords } from '../lib/agents';
import { unseenOf, type Seen } from '../lib/seen';
import { Icon, StateIcon } from '../components/Icon';
import { Dot, GROW, LABEL, Pane, PushTags, SUBLABEL, Tool, WORKING, row } from '../components/page';
import { Rail } from './Rail';
import { TaskMenu } from '../components/TaskMenu';
import { pullNow, useIndex, useTerminals } from '../state/server';
import { setPref, toggled, useUI } from '../state/ui';
import { isPaused } from '../lib/stops';
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
  // In sync it says so in a word; when it last asked origin is the tooltip's, not a clock ticking on the card.
  let head = 'Synced';
  let sub = '';
  if (!connected) {
    tone = 'down';
    head = 'yan serve stopped';
    sub = "start it again with 'yan serve'";
  } else if (pulling) {
    tone = 'busy';
    head = 'Pulling…';
  } else if (st?.local) {
    head = 'Local vault';
    sub = 'kept on this machine alone';
  } else if (st && !st.ok) {
    tone = 'warn';
    head = "Can't reach origin";
    sub = st.pulledAt ? `last pulled ${clock(st.pulledAt)}` : 'not pulled yet';
  } else if (st?.push.error) {
    // What the page changed is committed here and tried again on each pull; until then it is nowhere else.
    tone = 'warn';
    head = 'Not pushed yet';
    // One that conflicts never goes through on its own, however often it is tried.
    sub = /conflict/.test(st.push.error) ? 'it conflicts with origin - sort it out in the vault' : 'changes made here are tried again on each pull';
  }
  const every = st ? `${st.local ? 'Reads the vault here' : 'Pulls'} every ${st.everyS} s by itself${st.checkedAt ? `, last at ${clock(st.checkedAt, true)}` : ''}. ` : '';
  return (
    <button type="button" className="flex min-h-[50px] w-full cursor-pointer items-center gap-2.5 rounded-xl bg-card px-3 py-2 text-left" aria-label="Pull now"
      title={(st?.error ? `${st.error}\n` : '') + every + (st?.local ? 'Click to read it now.' : 'Click to pull now.')} onClick={() => void pullNow()}>
      <span className={cn('size-2 flex-none rounded-full', LIGHT[tone])} />
      <span className="flex min-w-0 flex-1 flex-col leading-[17px]">
        <b className="text-[13px]">{head}</b>
        {sub ? <span className="truncate text-xs/[17px] text-ink-3">{sub}</span> : null}
      </span>
      <Icon name="refresh" size={16} className={cn('text-ink-3', tone === 'busy' && 'animate-spin')} />
    </button>
  );
}

function TaskRow({ t, index, seen, on }: { t: TaskSummary; index: Index; seen: Seen; on: boolean }) {
  const last = useUI((s) => s.last[t.id]);
  const { data: terminals } = useTerminals();
  const state = terminals?.[t.id];
  const agent = state === undefined ? undefined : agentNews(t.id, state, seen);
  const marks = useUI((s) => s.prefs.badges);
  const fresh = on || !marks ? [] : [...unseenOf(index, seen, t.id).values()];
  return (
    <TaskMenu t={t} render={<a className={row({ on })} aria-current={on ? 'page' : undefined} href={last ?? link.task(t.id)} title={`${t.title || t.id} · ${t.id}${t.vault ? ` · in ${t.vault}` : ''}${agent ? ` · ${agentWords(agent)}` : ''}`} />}>
      <StateIcon t={t} />
      <span className={cn(GROW, agent?.kind === 'working' && WORKING)}>{t.title || t.id}</span>
      {agent?.news ? <Dot title={agentWords(agent)} tone={agent.kind === 'blocked' ? 'blocked' : 'finished'} /> : null}
      {fresh.length ? <span className="flex flex-none gap-1" title="since you last looked"><PushTags files={fresh} /></span> : null}
    </TaskMenu>
  );
}

/**
 * A month of tasks done or given up, or the tasks put aside, as one, folded
 * until it is clicked open, since they pile up and are rarely read again. Folded, it keeps in
 * view the task being read, and a dot says when one of its tasks has
 * something new, where nobody would otherwise see it.
 */
function MonthRows({ month, tasks, index, seen, openId, heading }: { month: string; tasks: readonly TaskSummary[]; index: Index; seen: Seen; openId: string | null; heading?: boolean }) {
  const open = useUI((s) => s.months.includes(month));
  const shown = open ? tasks : tasks.filter((t) => t.id === openId);
  const marks = useUI((s) => s.prefs.badges);
  const fresh = marks && !open && tasks.some((t) => t.id !== openId && unseenOf(index, seen, t.id).size > 0);
  return (
    <>
      {/* A sublabel that folds the tasks under it; its chevron sits where a task's icon does. */}
      <button type="button" aria-expanded={open}
        className={cn('flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-lg pt-1 pr-2.5 pb-0.5 text-left text-ink-3 hover:bg-hover hover:text-ink-2 focus-visible:-outline-offset-2',
          // Folding a whole group, it is the group's heading, in a heading's face and place; folding a month, a line under one.
          heading ? 'pl-2.5 text-[12.5px] font-bold' : 'pl-3 text-[12px]')}
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
    const tasks = works(index.tasks);
    const byTouched = (a: TaskSummary, b: TaskSummary): number => b.touched - a.touched;
    const out: { label: string; rows: ({ t: TaskSummary } | { month: string; tasks: TaskSummary[] })[]; none?: string; folds?: boolean }[] = [];
    // Waiting on `user`, so above the rest; the group is not there when none is.
    const uat = tasks.filter((t) => t.state === 'uat' && !isPaused(t)).sort(byTouched);
    if (uat.length) out.push({ label: 'In review', rows: uat.map((t) => ({ t })) });
    // A state this page does not know, a newer yan's, is taken as open, so the task is never left out of every group.
    const open = tasks.filter((t) => stateOf(t.state) === 'open' && !isPaused(t)).sort(byTouched);
    out.push({ label: 'In progress', rows: open.map((t) => ({ t })), none: 'Nothing open' });
    // Put aside, in review or in progress, below both: wanted again, but not now. The group is not there when none is.
    const paused = tasks.filter(isPaused).sort((a, b) => (fromIso(b.pausedAt) || b.touched) - (fromIso(a.pausedAt) || a.touched));
    // Folded as a month of done tasks is, the group's own name the line that folds it.
    if (paused.length) out.push({ label: 'Paused', rows: [{ month: 'Paused', tasks: paused }], folds: true });
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

  const shown = useUI((s) => s.prefs.left);
  const awake = useTerminals().data?.[JANUS] !== undefined;
  const creating = useUI((s) => s.newTask);
  const drafting = useUI((s) => s.drafts);
  const top = (
    <>
      <div className="flex items-center gap-2 py-0.5 pr-0.5 pl-2.5">
        <b className="text-[22px] tracking-tight" title={index ? `${index.vault.name} · ${index.vault.dir}` : undefined}>yan</b>
        <span className="flex-1" />
        {/* What this browser is set to, the theme, what the page says of what arrived, and yan's updates, is one box away. */}
        {/* Janus, for what is not a task yet: its terminal, a click from anywhere, where it is started when it is not running, which its mark gone grey says. */}
        <Tool name="janus" label={awake ? 'Janus' : 'Janus, not started'} href={link.terminal(JANUS)} newTab={false} blocked={!awake} small />
        <Tool name="settings" label="Settings" onClick={() => useUI.setState({ settings: true })} small />
        <Tool name="panel" label="Hide the task list" onClick={() => setPref('left', false)} small />
      </div>
      {/* Beside finding a task, starting one: a box asking what bare yan would, run in a new herdr tab. */}
      <div className="flex gap-1.5">
        {/* The task list's way into ⌘K, drawn as the box it opens. */}
        <button type="button" title={`Find a task (${MOD}K)`} className="flex h-[34px] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[10px] bg-hover pr-2 pl-2.5 text-[13.5px] text-ink-3 hover:text-ink-2"
          onClick={() => useUI.setState({ palette: true })}>
          <Icon name="search" size={15} />
          <span className={cn(GROW, 'text-left')}>Find a task</span>
        </button>
        <Button variant="secondary" size="icon-lg" className={cn('size-[34px] rounded-[10px] bg-hover text-ink-2 hover:bg-foreground/10 hover:text-foreground', creating && 'bg-foreground/10 text-foreground')} aria-label="New task" title="New task" onClick={() => useUI.setState({ newTask: true })}><Icon name="plus" size={16} /></Button>
        {/* The drafts are no task's: their box opens over whatever is shown. Beside starting a task, as its like, one more thing begun from here. */}
        <Button variant="secondary" size="icon-lg" className={cn('size-[34px] rounded-[10px] bg-hover text-ink-2 hover:bg-foreground/10 hover:text-foreground', drafting && 'bg-foreground/10 text-foreground')} aria-label="Drafts" title="Drafts" onClick={() => useUI.setState({ drafts: true })}><Icon name="note" size={16} /></Button>
      </div>
    </>
  );
  const body = !index || !seen ? null : (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <div className="flex flex-col gap-px" key={g.label}>
          {g.folds ? null : <div className={LABEL}>{g.label}</div>}
          {g.rows.length === 0 && g.none ? <div className={SUBLABEL}>{g.none}</div> : null}
          {g.rows.map((x) => ('month' in x
            ? <MonthRows key={`m:${x.month}`} month={x.month} tasks={x.tasks} index={index} seen={seen} openId={openId} heading={g.folds} />
            : <TaskRow key={x.t.id} t={x.t} index={index} seen={seen} on={x.t.id === openId} />))}
        </div>
      ))}
    </div>
  );
  // Folded, it is a rail, every open task a click away; the list stays drawn, hidden, its scroll and folds kept.
  return (
    <>
      {shown ? null : <Rail />}
      <nav className={cn('flex h-screen w-60 flex-none flex-col overflow-hidden bg-sunken max-[1100px]:w-[220px]', !shown && 'hidden')} aria-label="Tasks" aria-hidden={!shown || undefined}>
        <Pane tight top={top} body={body} foot={<Sync />} />
      </nav>
    </>
  );
}
