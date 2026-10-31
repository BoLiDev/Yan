import { useMemo, type ReactNode } from 'react';
import type { BranchView as Branch, TaskSummary } from '../../lib/api';
import { short, when } from '../../lib/format';
import { langOf } from '../../lib/highlight';
import { colourPatch, parsePatch, type PatchFile } from '../../lib/patch';
import { inBranch, type BranchRoute } from '../../lib/route';
import { Bar, BarSep, Empty, Notice, Stepper } from '../../components/page';
import { useCommit, useLangs } from '../../state/server';
import { useUI } from '../../state/ui';
import { useKeyNav } from '../nav';
import { DIFF, DiffBody, LINE_PX, linesOf } from './Diff';
import { DiffScroll, Later } from './Later';
import { LayoutTools, forgeTools } from './tools';

/** One file of a commit: its head at once, its lines, coloured, once they come near. */
function CommitFile({ f, r, layout, eager }: { f: PatchFile; r: BranchRoute; layout: 'unified' | 'split'; eager: boolean }) {
  return (
    <div className={DIFF}>
      <div className="flex items-center gap-2.5 border-b bg-[var(--raised)] px-3.5 py-2 font-sans text-[13px]">
        <a className="truncate font-bold text-ink hover:text-brand" href={inBranch(r, 'changes', f.path ?? '')}>{f.path}</a>
        {f.note.length ? <span className="text-ink-3">{f.note.join(', ')}</span> : null}
      </div>
      <Later height={linesOf(f) * LINE_PX} eager={eager}>{() => <ColouredDiff f={f} layout={layout} />}</Later>
    </div>
  );
}

function ColouredDiff({ f, layout }: { f: PatchFile; layout: 'unified' | 'split' }) {
  const coloured = useMemo(() => {
    const lang = langOf(f.path ?? '');
    if (!lang) return f;
    const copy = { ...f, hunks: f.hunks.map((hk) => ({ ...hk, lines: hk.lines.map((l) => ({ ...l })) })) };
    colourPatch(copy, lang);
    return copy;
  }, [f]);
  return <DiffBody f={coloured} layout={layout} />;
}

/** A commit of the branch: its message's body over the diff of each file it changed. */
export function CommitView({ t, r, b }: { t: TaskSummary; r: BranchRoute; b: Branch }) {
  const sha = r.item || b.commits[0]?.sha;
  const at = b.commits.findIndex((c) => c.sha === sha);
  const prev = at > 0 ? inBranch(r, 'commits', b.commits[at - 1]?.sha) : null;
  const next = at >= 0 && at < b.commits.length - 1 ? inBranch(r, 'commits', b.commits[at + 1]?.sha) : null;
  useKeyNav(prev, next);
  const layout = useUI((s) => s.prefs.layout);
  const full = useCommit(t.id, r.repo, sha);
  const files = useMemo(() => (full.data ? parsePatch(full.data.patch) : []), [full.data]);
  const ready = useLangs(files.map((x) => langOf(x.path ?? '')));
  if (!sha) return <Empty title="No commits">{`${b.branch} has nothing ${b.target} does not.`}</Empty>;
  const c = b.commits[at] ?? { sha, subject: short(sha), author: '', at: 0 };
  let body: ReactNode = <Empty>Loading…</Empty>;
  if (full.isError) body = <Empty><span className="text-destructive">{String(full.error.message)}</span></Empty>;
  else if (full.data && ready) {
    body = (
      <>
        {full.data.body ? <div className="mb-[18px] rounded-[10px] bg-card px-4 py-3 text-[13.5px]/[22px] whitespace-pre-wrap ring-1 ring-border">{full.data.body}</div> : null}
        {full.data.truncated ? <Notice>This commit is too big to show whole; it is cut short.</Notice> : null}
        {files.map((f, i) => <CommitFile key={`${f.path}:${i}`} f={f} r={r} layout={layout} eager={i < 2} />)}
      </>
    );
  }
  return (
    <>
      <Bar title={c.subject} meta={`${short(c.sha)} · ${c.author}${c.at ? ` · ${when(c.at)}` : ''}`}
        tools={<><Stepper prev={prev} next={next} pos={at + 1} total={b.commits.length} /><BarSep /><LayoutTools />{forgeTools(b).commit(c.sha)}</>} />
      <DiffScroll>{body}</DiffScroll>
    </>
  );
}
