import { useMemo, type ReactNode } from 'react';
import type { BranchView as Branch, TaskSummary } from '../../lib/api';
import { changeOrder } from '../../lib/files';
import { plural, short } from '../../lib/format';
import { langOf } from '../../lib/highlight';
import { colourPatch, parsePatch } from '../../lib/patch';
import { inBranch, type BranchRoute } from '../../lib/route';
import { sourceView } from '../../lib/source';
import { Bar, BarSep, Crumb, Empty, Stepper } from '../../components/page';
import { Toggle } from '../../components/ui/toggle';
import { useIndex, useLang, useText } from '../../state/server';
import { setPref, useUI } from '../../state/ui';
import { useKeyNav } from '../nav';
import { DIFF, DiffBody } from './Diff';
import { DiffScroll } from './Later';
import { LayoutTools, forgeTools } from './tools';

/** One file the branch changes, against the branch it goes into, with ← and → through the others. */
export function ChangesView({ t, r, b }: { t: TaskSummary; r: BranchRoute; b: Branch }) {
  // With source code alone, prev and next walk what the tree shows.
  const sourceOnly = useUI((s) => !s.prefs.allFiles);
  const rules = useIndex().data?.vault.source;
  const order = changeOrder(sourceOnly && rules ? sourceView(b, rules) : b);
  const path = r.item || order[0]?.path;
  const at = order.findIndex((f) => f.path === path);
  const f = order[at];
  const prev = at > 0 ? inBranch(r, 'changes', order[at - 1]?.path) : null;
  const next = at >= 0 && at < order.length - 1 ? inBranch(r, 'changes', order[at + 1]?.path) : null;
  useKeyNav(prev, next);
  const prefs = useUI((s) => s.prefs);
  const lang = langOf(path ?? '');
  const ready = useLang(lang);
  const q = f ? new URLSearchParams({ task: t.id, repo: String(r.repo), base: b.base, head: b.head, path: f.path, context: prefs.whole ? 'all' : '3', ...(f.from ? { from: f.from } : {}) }) : null;
  const patch = useText(q ? `/api/branch/diff?${q}` : null);
  // The diff with the whole file as context is fetched too, for the colours alone:
  // coloured entire, a comment or string a hunk starts inside is right.
  const wholeQ = q && !prefs.whole && lang ? new URLSearchParams({ ...Object.fromEntries(q), context: 'all' }) : null;
  const whole = useText(wholeQ ? `/api/branch/diff?${wholeQ}` : null);
  const one = useMemo(() => {
    if (patch.data === undefined || !f) return null;
    const parsed = parsePatch(patch.data)[0] ?? { from: null, to: null, path: f.path, hunks: [], binary: f.add === null, note: [] };
    if (ready) colourPatch(parsed, lang, whole.data !== undefined ? parsePatch(whole.data)[0] ?? null : prefs.whole ? parsed : null);
    return parsed;
  }, [patch.data, whole.data, ready, lang, prefs.whole, f]);
  if (!path) return <Empty title="No changes">{`${b.branch} changes nothing against ${b.target}.`}</Empty>;
  if (!f) return <Empty title="Not in this branch">{`${path} is not among the files ${b.branch} changes.`}</Empty>;
  const against = b.merged ? `as merged${b.merged.pr ? ` in PR #${b.merged.pr}` : ''}, against ${b.target} at ${short(b.base)}` : `against ${b.target} at ${short(b.base)}`;
  const meta = (
    <span>
      {f.add === null ? 'binary' : <><span className="text-success">{`+${f.add}`}</span>{' '}<span className="text-destructive">{`−${f.del}`}</span></>}
      {f.from ? ` · renamed from ${f.from}` : ''}{` · ${against}`}{one?.hunks.length ? ` · ${plural(one.hunks.length, 'hunk')}` : ''}
    </span>
  );
  let body: ReactNode = <Empty>Loading…</Empty>;
  if (patch.isError) body = <Empty><span className="text-destructive">{String(patch.error.message)}</span></Empty>;
  else if (one && (ready || !lang)) body = <div className={DIFF}><DiffBody f={one} layout={prefs.layout} /></div>;
  return (
    <>
      <Bar title={<Crumb path={f.path} />} meta={meta} tools={
        <>
          <Stepper prev={prev} next={next} pos={at + 1} total={b.files.length} />
          <BarSep />
          <LayoutTools />
          <Toggle size="sm" className="px-2.5 text-[13px] font-normal text-ink-2 data-[pressed]:text-foreground" pressed={prefs.whole} onPressedChange={(on) => setPref('whole', on)}>Whole file</Toggle>
          {f.status !== 'D' ? forgeTools(b).file(f.path) : null}
        </>
      } />
      <DiffScroll>{body}</DiffScroll>
    </>
  );
}
