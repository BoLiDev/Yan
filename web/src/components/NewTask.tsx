import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJSON } from '../lib/api';
import { link } from '../lib/route';
import { queryClient } from '../state/server';
import { useUI, type Launched } from '../state/ui';
import { AntIcon, Icon } from './Icon';

/** A repository a new task may work in, as serve offers it, with its packages when it has several. */
interface RepoOption {
  readonly name: string;
  readonly packages: readonly string[];
}

/** A ring of dashes, turning: a task being made. */
export const Ring = ({ size = 16 }: { size?: number }) => (
  <svg className="ring" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /></svg>
);

/**
 * The + beside Find a task: a new task asked for in a box over the page, a
 * step at a time, as bare `yan` asks it at a terminal. Its title first; then
 * the repositories it works in, each one picked a card, and for one with
 * several packages, which it is about, the whole repository unless some are
 * picked. A task with no repository to pick from is made from its title.
 * Created, it is bare `yan` in a new herdr tab, which the page then shows;
 * one serve cannot start says why here, and the box stays as it was.
 */
export function NewTaskModal() {
  const open = useUI((s) => s.newTask);
  return open ? <NewTaskBox /> : null;
}

function NewTaskBox() {
  const { data: repos } = useQuery({ queryKey: ['launch-repos'], queryFn: () => getJSON<RepoOption[]>('/api/launch/repos'), staleTime: 30_000 });
  const [step, setStep] = useState<'title' | 'repos'>('title');
  // Which way the step came, so it slides in from that side.
  const [way, setWay] = useState<'on' | 'back'>('on');
  const [title, setTitle] = useState('');
  // Each repository picked, with its packages: `[]` for the whole of it.
  const [picked, setPicked] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const before = useRef(document.activeElement as HTMLElement | null);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  // Until serve has said what there is, a second step is taken to come.
  const twoSteps = repos === undefined || repos.length > 0;
  const ready = title.trim() !== '';

  // The body's height follows the step it holds, so moving between them springs rather than jumps.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const sized = new ResizeObserver(() => setHeight(el.offsetHeight));
    sized.observe(el);
    return () => sized.disconnect();
  }, [step]);

  // Each step takes the keyboard as it comes: the title's field, or the first repository.
  useEffect(() => {
    if (step === 'title') field.current?.focus();
    else box.current?.querySelector<HTMLElement>('[data-repo]')?.focus();
  }, [step, repos]);

  const close = (then?: () => void): void => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => {
      useUI.setState({ newTask: false });
      if (then) then();
      else before.current?.focus({ preventScroll: true });
    }, 140);
  };
  const go = (to: 'title' | 'repos'): void => {
    setError(null);
    setWay(to === 'repos' ? 'on' : 'back');
    setStep(to);
  };
  const toggle = (name: string): void => setPicked((p) => {
    const { [name]: was, ...rest } = p;
    return was === undefined ? { ...p, [name]: [] } : rest;
  });
  // A package picked narrows the repository to the packages picked; the whole repository drops them.
  const scope = (name: string, pkg: string | null): void => setPicked((p) => {
    if (pkg === null) return { ...p, [name]: [] };
    const was = p[name] ?? [];
    return { ...p, [name]: was.includes(pkg) ? was.filter((x) => x !== pkg) : [...was, pkg] };
  });

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
    if (step === 'title' && twoSteps) go('repos');
    else void create();
  };

  // Enter goes on, Escape closes, ↑ and ↓ move between the repositories, Space picks one; Tab stays in the box.
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
      // ×, 上一步 and the step's own button do what they say; anywhere else Enter goes on, as Space picks.
      if (e.target instanceof HTMLButtonElement && e.target.closest('.new-repo') === null) return;
      e.preventDefault();
      forward();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && step === 'repos') {
      const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-repo]') ?? [])];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const to = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (to) {
        e.preventDefault();
        to.focus();
      }
    } else if (e.key === 'Tab') {
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
      <div ref={box} className="new-box" role="dialog" aria-modal="true" aria-label="新建 task" onKeyDown={onKey}>
        <div className="new-head">
          <b>新建 task</b>
          <button type="button" className="new-x" aria-label="关闭" onClick={() => close()}><AntIcon name="close" size={13} /></button>
        </div>
        {twoSteps ? <div className="new-steps" aria-hidden="true"><i className="on" /><i className={step === 'repos' ? 'on' : ''} /></div> : null}
        <div className="new-body" style={height === undefined ? undefined : { height }}>
          <div ref={inner} key={step} className={`new-step ${way}`}>
            {step === 'title' ? (
              <label className="new-field">
                <span className="new-label">标题</span>
                <input ref={field} className="new-title" value={title} spellCheck={false} onChange={(e) => setTitle(e.target.value)} />
              </label>
            ) : (
              <div className="new-field">
                <span className="new-label">仓库</span>
                <div className="new-repos">
                  {(repos ?? []).map((repo) => {
                    const on = picked[repo.name];
                    return (
                      <div key={repo.name} className={'new-repo' + (on !== undefined ? ' on' : '')}>
                        <button type="button" data-repo className="new-repo-row" aria-pressed={on !== undefined} onClick={() => toggle(repo.name)}>
                          <Icon name="branch" size={16} />
                          <span className="grow">{repo.name}</span>
                          <span className="new-check">{on !== undefined ? <AntIcon name="check" size={10} /> : null}</span>
                        </button>
                        {on !== undefined && repo.packages.length > 0 ? (
                          <div className="new-packages">
                            <button type="button" className={'chip' + (on.length === 0 ? ' on' : '')} aria-pressed={on.length === 0} onClick={() => scope(repo.name, null)}>整个仓库</button>
                            {repo.packages.map((pkg) => (
                              <button key={pkg} type="button" className={'chip' + (on.includes(pkg) ? ' on' : '')} aria-pressed={on.includes(pkg)} onClick={() => scope(repo.name, pkg)}>{pkg}</button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        {error !== null ? <div className="new-error" role="alert">{error}</div> : null}
        <div className="new-foot">
          {step === 'repos' ? <button type="button" className="button quiet" onClick={() => go('title')}>上一步</button> : null}
          <span className="grow" />
          {step === 'title' && twoSteps
            ? <button type="button" className="button" disabled={!ready} onClick={forward}>下一步</button>
            : <button type="button" className="button" disabled={!ready || busy} onClick={() => void create()}>{busy ? <><Ring size={14} />创建中</> : '创建'}</button>}
        </div>
      </div>
    </div>
  );
}
