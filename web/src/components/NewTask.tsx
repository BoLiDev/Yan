import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJSON } from '../lib/api';
import { link } from '../lib/route';
import { queryClient } from '../state/server';
import { useUI, type Launched } from '../state/ui';
import { AntIcon } from './Icon';

/** A repository a new task may work in, as serve offers it, with its packages when it has several. */
interface RepoOption {
  readonly name: string;
  readonly packages: readonly string[];
}

/** Where the keyboard is among the repositories: one, or one of a picked one's packages (`null` for the whole of it). */
interface Stop {
  readonly repo: string;
  readonly pkg?: string | null;
}
const stopKey = (s: Stop): string => (s.pkg === undefined ? s.repo : `${s.repo}\n${s.pkg ?? ''}`);

/** A ring of dashes, turning: a task being made. */
export const Ring = ({ size = 16 }: { size?: number }) => (
  <svg className="ring" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /></svg>
);

/**
 * The + beside Find a task: a new task asked for over the page as bare `yan`
 * asks it at a terminal, a step at a time, ① its title and ② the
 * repositories it works in, the two joined by a line that fills as the
 * second is reached. The repositories are picked as the terminal's list is:
 * › where the keyboard is, moved with ↑ and ↓ or the pointer, Space or a
 * click to pick, ● for what is picked; a repository with several packages,
 * picked, offers them under it, the whole repository unless some are. Enter
 * goes on, then creates; Escape closes. A task with no repository to pick
 * from is made from its title. Created, it is bare `yan` in a new herdr tab,
 * which the page then shows; one serve cannot start says why in a line, and
 * nothing asked is lost.
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
  const [picked, setPicked] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const before = useRef(document.activeElement as HTMLElement | null);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  // Until serve has said what there is, a second step is taken to come.
  const twoSteps = repos === undefined || repos.length > 0;
  const ready = title.trim() !== '';

  // Every place the keyboard can be, in order: each repository, and under a picked one with packages, each of them.
  const stops: Stop[] = (repos ?? []).flatMap((r) => {
    const own = picked[r.name];
    return [{ repo: r.name }, ...(own !== undefined && r.packages.length > 0 ? [{ repo: r.name, pkg: null }, ...r.packages.map((pkg) => ({ repo: r.name, pkg }))] : [])];
  });
  // A package gone with its repository's pick leaves the keyboard on the repository.
  const here = stops.findIndex((s) => stopKey(s) === at);
  const cursor = here >= 0 ? here : Math.max(0, stops.findIndex((s) => s.pkg === undefined && at.startsWith(`${s.repo}\n`)));

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
    else list.current?.focus();
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
  // A repository picked or let go; a package picked narrows its repository to the packages picked, the whole of it drops them.
  const pick = (s: Stop): void => {
    setAt(stopKey(s));
    setPicked((p) => {
      if (s.pkg === undefined) {
        const { [s.repo]: was, ...rest } = p;
        return was === undefined ? { ...p, [s.repo]: [] } : rest;
      }
      if (s.pkg === null) return { ...p, [s.repo]: [] };
      const was = p[s.repo] ?? [];
      return { ...p, [s.repo]: was.includes(s.pkg) ? was.filter((x) => x !== s.pkg) : [...was, s.pkg] };
    });
  };

  const create = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const made: Launched = { title: title.trim(), repos: Object.entries(picked).map(([name, s]) => ({ name, scope: s })) };
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
      close();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
      // × and 上一步 do what they say; anywhere else Enter goes on.
      if (e.target instanceof HTMLButtonElement && !e.target.classList.contains('new-go')) return;
      e.preventDefault();
      forward();
    } else if (step === 2 && stops.length > 0 && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault();
      const by = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      setAt(stopKey(stops[Math.max(0, Math.min(stops.length - 1, cursor + by))] as Stop));
    } else if (step === 2 && e.key === ' ' && e.target === list.current) {
      e.preventDefault();
      const s = stops[cursor];
      if (s) pick(s);
    } else if (e.key === 'Tab') {
      // The keyboard stays in the box.
      const all = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') ?? [])];
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

  const mark = <span className="new-mk" aria-hidden="true" />;
  return (
    <div className={'new-modal' + (leaving ? ' out' : '')} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={box} className="new-box" role="dialog" aria-modal="true" aria-label="新建 task" onKeyDown={onKey}>
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
              <div ref={list} className="new-opts" role="listbox" aria-label="仓库" aria-multiselectable tabIndex={0}>
                {(repos ?? []).map((repo) => {
                  const own = picked[repo.name];
                  const row: Stop = { repo: repo.name };
                  return (
                    <div key={repo.name}>
                      <div role="option" aria-selected={own !== undefined} className={'new-opt' + (own !== undefined ? ' on' : '') + (stops[cursor] !== undefined && stopKey(stops[cursor] as Stop) === repo.name ? ' at' : '')}
                        onMouseMove={() => setAt(repo.name)} onClick={() => pick(row)}>
                        <span className="new-ptr" aria-hidden="true">›</span>{mark}{repo.name}
                      </div>
                      {own !== undefined && repo.packages.length > 0 ? (
                        <div className="new-pkgs">
                          {[null, ...repo.packages].map((pkg) => {
                            const s: Stop = { repo: repo.name, pkg };
                            const on = pkg === null ? own.length === 0 : own.includes(pkg);
                            return (
                              <span key={pkg ?? ''} role="option" aria-selected={on} className={'new-pkg' + (on ? ' on' : '') + (stopKey(stops[cursor] ?? row) === stopKey(s) ? ' at' : '')}
                                onMouseMove={() => setAt(stopKey(s))} onClick={() => pick(s)}>
                                {mark}{pkg ?? '整个仓库'}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
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
