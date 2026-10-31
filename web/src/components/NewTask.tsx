import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJSON } from '../lib/api';
import { link } from '../lib/route';
import { queryClient } from '../state/server';
import { useUI, type Launched } from '../state/ui';
import { AntIcon } from './Icon';
import { MultiSelect } from './MultiSelect';

/** A repository a new task may work in, as serve offers it, with its packages when it has several. */
interface RepoOption {
  readonly name: string;
  readonly packages: readonly string[];
}

/** A ring of dashes, turning: a task being made. */
export const Ring = ({ size = 16 }: { size?: number }) => (
  <svg className="ring" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /></svg>
);

type Step = 'title' | 'repos' | 'packages';

/**
 * The + beside Find a task: a new task asked for over the page as bare `yan`
 * asks it at a terminal, a step at a time: ① its title, ② the repositories
 * it works in, and ③, when one picked has several packages, which of each
 * one's it is about, none picked being the whole of it. Each step picks one
 * thing from one list, in a select of several as antd's is, so nothing
 * cascades. The steps are numbers joined by lines that fill as each is
 * reached, ③ there only while a repository picked has packages. Enter goes
 * on, then creates, ⌘ or Ctrl with it creating at once; Escape closes. A
 * task with no repository to pick from is made from its title. Created, it
 * is bare `yan` in a new herdr tab, which the page then shows; one serve
 * cannot start says why in a line, and nothing asked is lost.
 */
export function NewTaskModal() {
  const open = useUI((s) => s.newTask);
  return open ? <NewTaskBox /> : null;
}

function NewTaskBox() {
  const { data: repos } = useQuery({ queryKey: ['launch-repos'], queryFn: () => getJSON<RepoOption[]>('/api/launch/repos'), staleTime: 30_000 });
  const [step, setStep] = useState<Step>('title');
  // Which way the step came, so it slides in from that side.
  const [way, setWay] = useState<'on' | 'back'>('on');
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  // Each picked monorepo's packages; none is the whole of it.
  const [scopes, setScopes] = useState<Readonly<Record<string, string[]>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const list = repos ?? [];
  // Until serve has said what there is, a second step is taken to come.
  const hasRepos = repos === undefined || repos.length > 0;
  // What was picked in the list's order, as bare yan's own list gives it: the first is where the agent starts.
  const picked = list.filter((r) => chosen.includes(r.name));
  const monorepos = picked.filter((r) => r.packages.length > 0);
  const steps: Step[] = ['title', ...(hasRepos ? ['repos' as const] : []), ...(monorepos.length > 0 ? ['packages' as const] : [])];
  const at = steps.indexOf(step);
  const last = at === steps.length - 1;
  const ready = title.trim() !== '';

  useEffect(() => {
    if (step === 'title') field.current?.focus();
  }, [step]);

  const close = (then?: () => void): void => {
    if (leaving) return;
    setLeaving(true);
    // The keyboard is not put back on the +: the box closing leaves nothing to do there, and its focus ring would stay.
    window.setTimeout(() => {
      useUI.setState({ newTask: false });
      then?.();
    }, 140);
  };
  const go = (to: Step): void => {
    const where = steps.indexOf(to);
    if (where < 0 || where === at || (where > at && !ready)) return;
    setError(null);
    setWay(where > at ? 'on' : 'back');
    setStep(to);
  };

  const create = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    // Every package of a repository picked is the whole of it.
    const made: Launched = {
      title: title.trim(),
      repos: picked.map((r) => {
        const own = scopes[r.name] ?? [];
        return { name: r.name, scope: own.length === r.packages.length ? [] : r.packages.filter((p) => own.includes(p)) };
      }),
    };
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
    if (last) void create();
    else go(steps[at + 1] as Step);
  };

  // A select's list takes ↑, ↓, Enter and Escape while it is open; what it lets through is the box's.
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey) {
      // × and 上一步 do what they say; anywhere else Enter goes on, ⌘ or Ctrl with it creating at once.
      if (e.target instanceof HTMLButtonElement && !e.target.classList.contains('new-go')) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) void create();
      else forward();
    } else if (e.key === 'Tab') {
      // The keyboard stays in the box.
      const all = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input') ?? [])];
      const [first, end] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        end?.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        first?.focus();
      }
    }
  };

  const names: Readonly<Record<Step, string>> = { title: '标题', repos: '仓库', packages: '包' };
  return (
    <div className={'new-modal' + (leaving ? ' out' : '')} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {/* A click on anything but a field or a button leaves the keyboard where it was, so Enter and Escape still reach the box. */}
      <div ref={box} className="new-box" role="dialog" aria-modal="true" aria-label="新建 task" onKeyDown={onKey}
        onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('input, button, .ms-field')) e.preventDefault(); }}>
        <div className="new-head">
          <b>新建 task</b>
          <button type="button" className="new-x" aria-label="关闭" onClick={() => close()}><AntIcon name="close" size={13} /></button>
        </div>
        {steps.length > 1 ? (
          <div className="new-steps">
            {steps.map((s, i) => (
              <span key={s} className={'new-stop' + (i > 0 ? ' joined' : '')}>
                {i > 0 ? <span className={'new-link' + (i <= at ? ' on' : '')} /> : null}
                <button type="button" tabIndex={-1} className={i === at ? 'at' : i < at ? 'done' : ''} disabled={i > at && !ready} onClick={() => go(s)}>
                  <span className="new-num">{i + 1}</span>{names[s]}
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="new-body">
          <div key={step} className={`new-step ${way}`}>
            {step === 'title' ? (
              <input ref={field} className="new-title" aria-label="标题" value={title} spellCheck={false} onChange={(e) => setTitle(e.target.value)} />
            ) : step === 'repos' ? (
              <MultiSelect label="仓库" options={list.map((r) => r.name)} value={chosen} autoFocus
                onChange={(next) => setChosen(list.filter((r) => next.includes(r.name)).map((r) => r.name))} />
            ) : (
              <div className="new-scopes">
                {monorepos.map((r, i) => (
                  <div key={r.name} className="new-scope">
                    <span className="new-scope-name">{r.name}</span>
                    <MultiSelect label={`${r.name} 的包`} options={r.packages} value={scopes[r.name] ?? []} empty="整个仓库" autoFocus={i === 0}
                      onChange={(next) => setScopes((s) => ({ ...s, [r.name]: r.packages.filter((p) => next.includes(p)) }))} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="new-foot">
          {at > 0 ? <button type="button" className="new-back" onClick={() => go(steps[at - 1] as Step)}>上一步</button> : null}
          <span className="new-error" role="alert">{error ?? ''}</span>
          <button type="button" className="button new-go" disabled={!ready || busy} onClick={forward}>
            {busy ? <><Ring size={14} />创建中</> : <>{last ? '创建' : '下一步'}<span className="new-kb" aria-hidden="true">↵</span></>}
          </button>
        </div>
      </div>
    </div>
  );
}
