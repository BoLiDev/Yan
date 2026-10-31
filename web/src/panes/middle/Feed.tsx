import type { Index, Push } from '../../lib/api';
import { dayLabel } from '../../lib/format';
import type { Route } from '../../lib/route';
import { markAllSeen, unseenOf, unseenPushes, type Seen } from '../../lib/seen';
import { GROW, Pane, SUBLABEL } from '../../components/page';
import { Button } from '../../components/ui/button';
import { setSeen } from '../../state/ui';
import { SECTION } from './look';
import { PushItem } from './Push';

/**
 * Latest: what arrived and has not been looked at, newest first, a line a
 * push: when, which task, and how many files it added, changed and deleted.
 * Each opens to its files, and a file opens on the right; the arrow at its
 * end opens the task itself, its overview. The push holding the file being
 * shown is open.
 */
export function Feed({ index, seen, r }: { index: Index; seen: Seen; r: Extract<Route, { view: 'latest' }> }) {
  const pushes = unseenPushes(index, seen);
  const showing = r.id ? pushes.find((p) => p.task === r.id && p.files.some((f) => f.path === r.path)) : undefined;
  const unseen = new Map([...new Set(pushes.map((p) => p.task))].map((id) => [id, unseenOf(index, seen, id)]));
  const days: { label: string; pushes: Push[] }[] = [];
  for (const p of pushes) {
    const label = dayLabel(p.at);
    if (days.at(-1)?.label !== label) days.push({ label, pushes: [] });
    (days.at(-1) as { pushes: Push[] }).pushes.push(p);
  }
  const heading = (
    <div className={SECTION}>
      <h1 className="text-[19px]/[26px]">Latest</h1>
      <span className={GROW} />
      <Button variant="ghost" size="sm" className="text-brand hover:text-brand-ink" onClick={() => setSeen((s) => markAllSeen(index, s))}>Mark all seen</Button>
    </div>
  );
  const body = (
    <>
      {!pushes.length ? <div className={SUBLABEL}>{index.latest.length ? 'Nothing new since you last looked.' : 'Nothing has arrived in any task’s artifacts yet.'}</div> : null}
      {days.map((d) => (
        <div className="flex flex-col gap-0.5" key={d.label}>
          <div className="px-2.5 py-1 text-[12.5px] font-bold text-ink-3">{d.label}</div>
          {d.pushes.map((p) => (
            <PushItem key={`${p.task}@${p.at}`} p={p} title={index.tasks.find((x) => x.id === p.task)?.title || p.task} holding={p === showing} r={r} unseen={unseen.get(p.task)} />
          ))}
        </div>
      ))}
    </>
  );
  return <Pane remember="latest" top={heading} body={body} />;
}
