import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJSON } from '../lib/api';
import { findPicks, packageOn, stateOf, tickPackage, tickRepo, type Checked, type Hit, type Picked, type RepoOption } from '../lib/pick';
import { link } from '../lib/route';
import { queryClient } from '../state/server';
import { useUI, type Launched } from '../state/ui';
import { AntIcon, Icon } from './Icon';
import { Marked } from './Palette';

/** A box ticked, part-ticked or empty, as antd's Cascader draws one. */
const Check = ({ state, onClick }: { state: Checked; onClick?: (e: MouseEvent) => void }) => (
  <span className={`casc-cb ${state}`} aria-hidden="true" onClick={onClick}>{state === 'on' ? <AntIcon name="check" size={10} /> : null}</span>
);

/** A ring of dashes, turning: a task being made. */
export const Ring = ({ size = 16 }: { size?: number }) => (
  <svg className="ring" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /></svg>
);

/**
 * The + beside Find a task: a new task asked for over the page as bare `yan`
 * asks it at a terminal, a step at a time, ① its title and ② the
 * repositories it works in, the two joined by a line that fills as the
 * second is reached. The repositories are picked as antd's Cascader picks
 * several: a column of them and, beside it, the packages of the one open; a
 * repository ticked is the whole of it, some of its packages ticked are
 * those alone, its box part-ticked, and all of them ticked are the whole of
 * it again. ↑ and ↓ move in a column, → and ← between them, Space ticks.
 * What is typed searches both, as ⌘K searches the tasks: the repositories by
 * name and the packages by their path, `web / packages/core`, in one list,
 * clicked to tick or ticked with Enter, which clears the search. Enter goes
 * on, then creates, ⌘ or Ctrl with it creating at once; Escape clears the
 * search, then closes. A task with no repository to
 * pick from is made from its title. Created, it is bare `yan` in a new herdr
 * tab, which the page then shows; one serve cannot start says why in a
 * line, and nothing asked is lost.
 */
export function NewTaskModal() {
  const open = useUI((s) => s.newTask);
  return open ? <NewTaskBox /> : null;
}

function NewTaskBox() {
  const { data: repos } = useQuery({ queryKey: ['launch-repos'], queryFn: () => getJSON<RepoOption[]>('/api/launch/repos'), staleTime: 30_000 });
  const [step, setStep] = useState<1 | 2>(1);
  // Which way the step came, so it slides in from that side.
  const [way, setWay] = useState<'on' | 'back'>('on');
  const [title, setTitle] = useState('');
  // Each repository picked, with its packages: `[]` for the whole of it.
  const [picked, setPicked] = useState<Picked>({});
  const [query, setQuery] = useState('');
  // Where the keyboard is among what a search found.
  const [hit, setHit] = useState(0);
  // Where the keyboard is: a row of the repositories' column, or of the open one's packages.
  const [cursor, setCursor] = useState<{ col: 0 | 1; row: number }>({ col: 0, row: 0 });
  const [open, setOpen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const before = useRef(document.activeElement as HTMLElement | null);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  // Until serve has said what there is, a second step is taken to come.
  const twoSteps = repos === undefined || repos.length > 0;
  const ready = title.trim() !== '';

  const list = repos ?? [];
  const opened = list[open];
  const searching = query.trim() !== '';
  const hits = searching ? findPicks(list, query) : [];

  // What the keyboard is on stays in sight as it moves through a long list.
  useLayoutEffect(() => {
    box.current?.querySelector('.casc-it.at')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, hit, searching]);

  // The body's height follows the step it holds, so moving between them springs rather than jumps.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const sized = new ResizeObserver(() => setHeight(el.offsetHeight));
    sized.observe(el);
    return () => sized.disconnect();
  }, [step]);

  // Each step takes the keyboard as it comes: the title, or the list.
  useEffect(() => {
    if (step === 1) field.current?.focus();
    else search.current?.focus();
  }, [step]);

  const close = (then?: () => void): void => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => {
      useUI.setState({ newTask: false });
      if (then) then();
      else before.current?.focus({ preventScroll: true });
    }, 140);
  };
  const go = (to: 1 | 2): void => {
    if (to === step || (to === 2 && (!ready || !twoSteps))) return;
    setError(null);
    setWay(to === 2 ? 'on' : 'back');
    setStep(to);
  };
  const repoTicked = (r: RepoOption): void => setPicked((p) => tickRepo(p, r));
  const packageTicked = (r: RepoOption, pkg: string): void => setPicked((p) => tickPackage(p, r, pkg));
  const hitTicked = (h: Hit): void => (h.pkg === undefined ? repoTicked(h.repo) : packageTicked(h.repo, h.pkg));
  const hitState = (h: Hit): Checked => (h.pkg === undefined ? stateOf(picked, h.repo) : packageOn(picked, h.repo, h.pkg) ? 'on' : 'off');
  const point = (col: 0 | 1, row: number): void => {
    setCursor({ col, row });
    if (col === 0) setOpen(row);
  };

  const create = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    // In the list's order, as bare yan's own list gives them: the first is where the agent starts.
    const made: Launched = { title: title.trim(), repos: list.flatMap((r) => (picked[r.name] === undefined ? [] : [{ name: r.name, scope: picked[r.name] as readonly string[] }])) };
    try {
      const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(made) });
      if (!r.ok) {
        setError((await r.text()) || `serve 答了 ${r.status}`);
        return;
      }
      const { launch } = (await r.json()) as { launch: string };
      useUI.setState((s) => ({ launched: { ...s.launched, [launch]: made } }));
      void queryClient.invalidateQueries({ queryKey: ['terminals'] });
      close(() => {
        location.hash = link.new(launch);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const forward = (): void => {
    if (!ready) return;
    if (step === 1 && twoSteps) go(2);
    else void create();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (step === 2 && query !== '') setQuery('');
      else close();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
      // × and 上一步 do what they say. While a search is shown, Enter ticks what the keyboard is on and the search
      // goes, as antd's does, so the next Enter creates; ⌘ or Ctrl with it creates at once. Anywhere else it goes on.
      if (e.target instanceof HTMLButtonElement && !e.target.classList.contains('new-go')) return;
      e.preventDefault();
      if (step === 2 && searching && !(e.metaKey || e.ctrlKey)) {
        const h = hits[hit];
        if (h) hitTicked(h);
        setQuery('');
        setHit(0);
      } else if (e.metaKey || e.ctrlKey) void create();
      else forward();
    } else if (step === 2 && searching && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setHit((h) => Math.max(0, Math.min(hits.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (step === 2 && searching) {
      // Space, ← and → are the search's, as in any field.
    } else if (step === 2 && list.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const rows = cursor.col === 0 ? list.length : (opened?.packages.length ?? 0);
      point(cursor.col, Math.max(0, Math.min(rows - 1, cursor.row + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (step === 2 && e.key === 'ArrowRight' && cursor.col === 0 && (opened?.packages.length ?? 0) > 0) {
      e.preventDefault();
      setCursor({ col: 1, row: 0 });
    } else if (step === 2 && e.key === 'ArrowLeft' && cursor.col === 1) {
      e.preventDefault();
      setCursor({ col: 0, row: open });
    } else if (step === 2 && e.key === ' ' && e.target === search.current) {
      e.preventDefault();
      if (cursor.col === 0 && list[cursor.row]) repoTicked(list[cursor.row] as RepoOption);
      else if (cursor.col === 1 && opened?.packages[cursor.row] !== undefined) packageTicked(opened, opened.packages[cursor.row] as string);
    } else if (e.key === 'Tab') {
      // The keyboard stays in the box.
      const all = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])];
      const [first, last] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div className={'new-modal' + (leaving ? ' out' : '')} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {/* A click on anything but a field or a button leaves the keyboard where it was, so Enter and Escape still reach the box. */}
      <div ref={box} className="new-box" role="dialog" aria-modal="true" aria-label="新建 task" onKeyDown={onKey}
        onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('input, button')) e.preventDefault(); }}>
        <div className="new-head">
          <b>新建 task</b>
          <button type="button" className="new-x" aria-label="关闭" onClick={() => close()}><AntIcon name="close" size={13} /></button>
        </div>
        {twoSteps ? (
          <div className="new-steps">
            <button type="button" tabIndex={-1} className={step === 1 ? 'at' : 'done'} onClick={() => go(1)}><span className="new-num">1</span>标题</button>
            <span className={'new-link' + (step === 2 ? ' on' : '')} />
            <button type="button" tabIndex={-1} className={step === 2 ? 'at' : ''} disabled={!ready} onClick={() => go(2)}><span className="new-num">2</span>仓库</button>
          </div>
        ) : null}
        <div className="new-body" style={height === undefined ? undefined : { height }}>
          <div ref={inner} key={step} className={`new-step ${way}`}>
            {step === 1 ? (
              <input ref={field} className="new-title" aria-label="标题" value={title} spellCheck={false} onChange={(e) => setTitle(e.target.value)} />
            ) : (
              <div className="casc-pick">
                <label className="casc-search">
                  <Icon name="search" size={15} />
                  <input ref={search} value={query} placeholder="搜索" aria-label="搜索仓库和包" spellCheck={false} autoComplete="off"
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setHit(0);
                    }} />
                </label>
                {searching ? (
                  <div className="casc-hits" role="listbox" aria-label="仓库和包" aria-multiselectable>
                    {hits.length === 0 ? <div className="casc-none">没有匹配的仓库或包</div> : hits.map((h, i) => (
                      <div key={h.label} role="option" aria-selected={hitState(h) !== 'off'} className={'casc-it' + (i === hit ? ' at' : '')}
                        onMouseEnter={() => setHit(i)} onClick={() => hitTicked(h)}>
                        <Check state={hitState(h)} />
                        <span className="grow"><Marked text={h.label} marks={h.marks} /></span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="casc" role="tree" aria-label="仓库" aria-multiselectable>
                    <div className="casc-col" role="group">
                      {list.map((r, i) => (
                        <div key={r.name} role="treeitem" aria-selected={stateOf(picked, r) !== 'off'} aria-expanded={r.packages.length > 0 ? i === open : undefined}
                          className={'casc-it' + (i === open && r.packages.length > 0 ? ' open' : '') + (cursor.col === 0 && cursor.row === i ? ' at' : '')}
                          onMouseEnter={() => point(0, i)} onClick={() => (r.packages.length > 0 ? point(0, i) : repoTicked(r))}>
                          <Check state={stateOf(picked, r)} onClick={(e) => {
                            e.stopPropagation();
                            point(0, i);
                            repoTicked(r);
                          }} />
                          <span className="grow">{r.name}</span>
                          {r.packages.length > 0 ? <Icon name="chev" size={12} /> : null}
                        </div>
                      ))}
                    </div>
                    <div className="casc-col" role="group">
                      {opened !== undefined ? opened.packages.map((pkg, j) => (
                        <div key={`${opened.name}/${pkg}`} role="treeitem" aria-selected={packageOn(picked, opened, pkg)} className={'casc-it' + (cursor.col === 1 && cursor.row === j ? ' at' : '')}
                          onMouseEnter={() => setCursor({ col: 1, row: j })} onClick={() => packageTicked(opened, pkg)}>
                          <Check state={packageOn(picked, opened, pkg) ? 'on' : 'off'} />
                          <span className="grow">{pkg}</span>
                        </div>
                      )) : null}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="new-foot">
          {step === 2 ? <button type="button" className="new-back" onClick={() => go(1)}>上一步</button> : null}
          <span className="new-error" role="alert">{error ?? ''}</span>
          <button type="button" className="button new-go" disabled={!ready || busy} onClick={forward}>
            {busy ? <><Ring size={14} />创建中</> : <>{step === 1 && twoSteps ? '下一步' : '创建'}<span className="new-kb" aria-hidden="true">↵</span></>}
          </button>
        </div>
      </div>
    </div>
  );
}
