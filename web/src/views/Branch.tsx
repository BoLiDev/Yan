import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BranchView as Branch, TaskSummary } from '../lib/api';
import { baseName, changeOrder, enc, ext, kindOf, viewerOf } from '../lib/files';
import { bytes, plural, short, when } from '../lib/format';
import { langOf } from '../lib/highlight';
import { colourPatch, parsePatch, splitPairs, type PatchFile, type PatchLine } from '../lib/patch';
import { inBranch, type BranchRoute } from '../lib/route';
import { sourceView } from '../lib/source';
import { Bar, BarSep, Crumb, Empty, Seg, Stepper, Tool } from '../components/page';
import { Toggle } from '../components/ui/toggle';
import { useBranch, useBranchTree, useCommit, useIndex, useLang, useLangs, useText } from '../state/server';
import { setPref, useUI } from '../state/ui';
import { CodeStage, CodeText } from './Code';
import { MarkdownDoc } from './Markdown';
import { useKeyNav } from './nav';

const DIFF_LIMIT = 5000;
/** A line of a diff is this tall unless it wraps: what a part not drawn yet holds for it. */
const LINE_PX = 21;
/** The lines drawn together once they come near. */
const CHUNK = 200;

/**
 * What is inside drawn only once it comes within a few screens of being
 * seen, holding its guessed height till then, and kept once drawn. A commit
 * can change tens of thousands of lines; drawn at once they are a hundred
 * thousand elements and the page stops for a second over them, though a
 * screenful is all that is seen.
 */
function Later({ height, className, eager = false, children }: { height: number; className?: string; eager?: boolean; children: () => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // What starts on screen is drawn with the rest, not a frame after it.
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const el = box.current;
    if (!el || near) return undefined;
    const watch = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) setNear(true);
    }, { root: el.closest('.diff-scroll'), rootMargin: '2000px 0px' });
    watch.observe(el);
    return () => watch.disconnect();
  }, [near]);
  return <div ref={box} className={className} style={near ? undefined : { height: `${height}px` }}>{near ? children() : null}</div>;
}

function Half({ l, side }: { l: PatchLine | null; side: 'a' | 'b' }) {
  if (!l) return <div className="half none"><span className="a" /><span className="t" /></div>;
  return (
    <div className={'half' + (l.k === 'ctx' ? '' : ` ${l.k}`)}>
      <span className="a">{side === 'a' ? l.a ?? '' : l.b ?? ''}</span>
      <CodeText text={l.t} html={l.h} />
    </div>
  );
}

/** How many lines a file's diff shows, its hunks' heads among them, for the height it holds before it is drawn. */
function linesOf(f: PatchFile): number {
  return Math.max(1, Math.min(DIFF_LIMIT + 1, f.hunks.reduce((n, hk) => n + 1 + hk.lines.length, 0)));
}

/** A file's changes, unified or side by side, cut past 5,000 lines, drawn a part at a time as they come near. */
function DiffBody({ f, layout }: { f: PatchFile; layout: 'unified' | 'split' }) {
  const plain = { padding: '10px 14px', fontFamily: 'var(--font)' };
  if (f.binary) return <div className="dl"><span className="t" style={plain}>A binary file: no lines to compare.</span></div>;
  if (!f.hunks.length) return <div className="dl"><span className="t" style={plain}>{f.note.length ? `${f.note.join(', ')}, empty` : 'Only the mode changed.'}</span></div>;
  let count = 0;
  // One entry a line of the page: a pair side by side is one, in the grid as its two halves.
  const rows: ReactNode[] = [];
  f.hunks.forEach((hk, h) => {
    if (count > DIFF_LIMIT) return;
    if (layout === 'split') {
      rows.push(<div className="hunk" key={`h${h}`}>{hk.head}</div>);
      splitPairs(hk.lines).forEach(([l, r], i) => {
        rows.push(<Fragment key={`${h}:${i}`}><Half l={l} side="a" /><Half l={r} side="b" /></Fragment>);
        count++;
      });
    } else {
      rows.push(<div className="dl hunk" key={`h${h}`}><span className="a" /><span className="b" /><span className="s" /><span className="t">{hk.head}</span></div>);
      hk.lines.forEach((l, i) => {
        rows.push(
          <div className={`dl ${l.k}`} key={`${h}:${i}`}>
            <span className="a">{l.a ?? ''}</span><span className="b">{l.b ?? ''}</span>
            <span className="s">{l.k === 'add' ? '+' : l.k === 'del' ? '−' : ''}</span>
            <CodeText text={l.t} html={l.h} />
          </div>,
        );
        count++;
      });
    }
    if (count > DIFF_LIMIT) {
      rows.push(<div className="dl" style={{ gridColumn: '1 / -1' }} key="cut"><span className="t" style={{ ...plain, color: 'var(--ink-3)' }}>{`Cut at ${DIFF_LIMIT.toLocaleString()} lines.`}</span></div>);
    }
  });
  const grid = layout === 'split' ? 'split' : undefined;
  if (rows.length <= CHUNK) return <div className={grid}>{rows}</div>;
  const parts: ReactNode[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    parts.push(<Later key={i} height={part.length * LINE_PX} className={grid} eager={i === 0}>{() => part}</Later>);
  }
  return <div>{parts}</div>;
}

/** One file of a commit: its head at once, its lines, coloured, once they come near. */
function CommitFile({ f, r, layout, eager }: { f: PatchFile; r: BranchRoute; layout: 'unified' | 'split'; eager: boolean }) {
  return (
    <div className="diff">
      <div className="diff-file-head"><a href={inBranch(r, 'changes', f.path ?? '')}>{f.path}</a>{f.note.length ? <span className="dim">{f.note.join(', ')}</span> : null}</div>
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

function LayoutTools() {
  const layout = useUI((s) => s.prefs.layout);
  return <Seg options={[['unified', 'Unified'], ['split', 'Split']] as const} current={layout} onPick={(v) => setPref('layout', v)} />;
}

function forgeTools(b: Branch) {
  // GitHub or GitLab, each with its own way to a commit and a file; none for a forge yan cannot tell.
  const forge = b.links.forge;
  return {
    commit: (sha: string): ReactNode => (forge ? <Tool name="external" label={`Open the commit on ${forge.name}`} href={forge.commit.replaceAll('{sha}', sha)} /> : null),
    file: (path: string): ReactNode => (forge ? <Tool name="external" label={`Open the file on ${forge.name}`} href={forge.blob.replaceAll('{ref}', encodeURIComponent(b.head)).replaceAll('{path}', enc(path))} /> : null),
  };
}

function CommitView({ t, r, b }: { t: TaskSummary; r: BranchRoute; b: Branch }) {
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
  if (full.isError) body = <Empty><span className="error">{String(full.error.message)}</span></Empty>;
  else if (full.data && ready) {
    body = (
      <>
        {full.data.body ? <div className="commit-body">{full.data.body}</div> : null}
        {full.data.truncated ? <div className="notice">This commit is too big to show whole; it is cut short.</div> : null}
        {files.map((f, i) => <CommitFile key={`${f.path}:${i}`} f={f} r={r} layout={layout} eager={i < 2} />)}
      </>
    );
  }
  return (
    <>
      <Bar title={c.subject} meta={`${short(c.sha)} · ${c.author}${c.at ? ` · ${when(c.at)}` : ''}`}
        tools={<><Stepper prev={prev} next={next} pos={at + 1} total={b.commits.length} /><BarSep /><LayoutTools />{forgeTools(b).commit(c.sha)}</>} />
      <div className="diff-scroll">{body}</div>
    </>
  );
}

function BranchFile({ t, r, b }: { t: TaskSummary; r: BranchRoute; b: Branch }) {
  useKeyNav(null, null);
  const tree = useBranchTree(t.id, r.repo, b.head, !!r.item);
  const dark = useUI((s) => s.prefs.dark);
  const entry = tree.data?.find((f) => f.path === r.item);
  const url = entry ? `/api/branch/blob?task=${encodeURIComponent(t.id)}&repo=${r.repo}&sha=${entry.sha}` : null;
  const name = entry ? baseName(entry.path) : '';
  const isMarkdown = !!entry && viewerOf(name) === 'markdown';
  const text = useText(isMarkdown ? url : null);
  if (!r.item) return <Empty title={`${b.repo} at ${short(b.head)}`}>{`Every file on ${b.branch} — pick one in the middle.`}</Empty>;
  if (!tree.data) return <Empty title="Reading the files…" />;
  if (!entry || !url) return <Empty title="Not on the branch">{`${r.item} is not on ${b.branch}.`}</Empty>;
  let stage: ReactNode;
  if (kindOf(name) === 'image' && ext(name) !== 'svg') {
    stage = <div className={'stage' + (dark ? ' dark' : '')}><img className="shot" src={`${url}&name=${encodeURIComponent(name)}`} alt={name} /></div>;
  } else if (isMarkdown) {
    stage = (
      <div className="stage top">
        {text.data !== undefined ? (
          <div className="w-full max-w-[1000px] rounded-xl bg-card ring-1 ring-border"><MarkdownDoc text={text.data} /></div>
        ) : null}
      </div>
    );
  } else {
    stage = <CodeStage url={url} name={name} size={entry.size} />;
  }
  return (
    <>
      <Bar title={<Crumb path={entry.path} />} meta={bytes(entry.size)} tools={forgeTools(b).file(entry.path)} />
      {stage}
    </>
  );
}

function ChangesView({ t, r, b }: { t: TaskSummary; r: BranchRoute; b: Branch }) {
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
      {f.add === null ? 'binary' : <><span style={{ color: 'var(--green)' }}>{`+${f.add}`}</span>{' '}<span style={{ color: 'var(--red)' }}>{`−${f.del}`}</span></>}
      {f.from ? ` · renamed from ${f.from}` : ''}{` · ${against}`}{one?.hunks.length ? ` · ${plural(one.hunks.length, 'hunk')}` : ''}
    </span>
  );
  let body: ReactNode = <Empty>Loading…</Empty>;
  if (patch.isError) body = <Empty><span className="error">{String(patch.error.message)}</span></Empty>;
  else if (one && (ready || !lang)) body = <div className="diff"><DiffBody f={one} layout={prefs.layout} /></div>;
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
      <div className="diff-scroll">{body}</div>
    </>
  );
}

/** A task's branch on the right: a file's changes, a commit, or a file as the branch has it. */
export function BranchView({ t, r }: { t: TaskSummary; r: BranchRoute }) {
  const { data: b } = useBranch(t.id, r.repo, r.name);
  if (!b) return <NoNav><Empty title="Reading the branch…" /></NoNav>;
  if (b.missing) return <NoNav><Empty title="Nothing to show">{b.missing}</Empty></NoNav>;
  if (r.tab === 'commits') return <CommitView t={t} r={r} b={b} />;
  if (r.tab === 'files') return <BranchFile t={t} r={r} b={b} />;
  return <ChangesView t={t} r={r} b={b} />;
}

function NoNav({ children }: { children: ReactNode }) {
  useKeyNav(null, null);
  return <>{children}</>;
}
