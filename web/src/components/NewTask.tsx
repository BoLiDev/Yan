import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJSON, postJSON, type LaunchRepo as RepoOption } from '../lib/api';
import { link } from '../lib/route';
import { cn } from '../lib/utils';
import { queryClient } from '../state/server';
import { useUI, type Launched } from '../state/ui';
import { MultiSelect } from './MultiSelect';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Kbd } from './ui/kbd';
import { Spinner } from './ui/spinner';

type Step = 'title' | 'repos' | 'packages';

/**
 * The + beside Find a task: a new task asked for over the page as bare `yan`
 * asks it at a terminal, a step at a time: ① its title, ② the repositories
 * it works in, and ③, when one picked has several packages, which of each
 * one's it is about, none picked being the whole of it. Each step picks one
 * thing from one list, in a select of several, so nothing cascades. The
 * steps are numbers joined by lines that fill as each is reached, ③ there
 * only while a repository picked has packages. Enter goes on, then creates,
 * ⌘ or Ctrl with it creating at once; Escape closes. A task with no
 * repository to pick from is made from its title. Created, it is bare `yan`
 * in a new herdr tab, which the page then shows; one serve cannot start
 * says why in a line, and nothing asked is lost.
 */
export function NewTaskModal() {
  const open = useUI((s) => s.newTask);
  return (
    <Dialog open={open} onOpenChange={(next) => useUI.setState({ newTask: next })}>
      {/* Its own each time it opens: a box closed and opened again asks afresh. */}
      <DialogContent className="top-[14vh] max-w-[500px] translate-y-0 gap-0 p-6 sm:max-w-[500px]">
        {open ? <NewTaskBox /> : null}
      </DialogContent>
    </Dialog>
  );
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
      const { launch } = await postJSON<{ launch: string }>('/api/launch', made);
      useUI.setState((s) => ({ launched: { ...s.launched, [launch]: made }, newTask: false }));
      void queryClient.invalidateQueries({ queryKey: ['terminals'] });
      location.hash = link.new(launch);
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
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.shiftKey || e.defaultPrevented) return;
    // Back and close do what they say; anywhere else Enter goes on, ⌘ or Ctrl with it creating at once.
    if (e.target instanceof HTMLButtonElement && !e.target.dataset.go) return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) void create();
    else forward();
  };

  const names: Readonly<Record<Step, string>> = { title: 'Title', repos: 'Repositories', packages: 'Packages' };
  return (
    <div className="flex flex-col" onKeyDown={onKey}>
      <DialogTitle className="text-base">New task</DialogTitle>
      {steps.length > 1 ? (
        <div className="mt-5 flex items-center gap-2.5 text-[13px]">
          {steps.map((s, i) => (
            <span key={s} className={cn('flex flex-none items-center gap-2.5', i > 0 && 'flex-1')}>
              {i > 0 ? (
                <span className="relative h-[1.5px] flex-1 overflow-hidden rounded-[1px] bg-border">
                  <span className={cn('absolute inset-0 origin-left bg-brand transition-transform duration-400', i <= at ? 'scale-x-100' : 'scale-x-0')} />
                </span>
              ) : null}
              <button type="button" tabIndex={-1} disabled={i > at && !ready} onClick={() => go(s)}
                className={cn('inline-flex items-center gap-2 text-muted-foreground transition-colors disabled:cursor-default', i <= at && 'font-bold text-foreground')}>
                <span className={cn('inline-flex size-[22px] items-center justify-center rounded-full text-xs font-bold tabular-nums ring-[1.5px] ring-border ring-inset',
                  i < at && 'bg-brand text-primary-foreground ring-brand', i === at && 'text-brand ring-brand')}>{i + 1}</span>
                {names[s]}
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="-mx-6 overflow-hidden">
        <div key={step} className={cn('px-6 pt-[18px] pb-0.5 duration-300 animate-in fade-in-0', way === 'on' ? 'slide-in-from-right-7' : 'slide-in-from-left-7')}>
          {step === 'title' ? (
            <Input ref={field} aria-label="Title" value={title} spellCheck={false} onChange={(e) => setTitle(e.target.value)} className="h-10 text-[15px]" />
          ) : step === 'repos' ? (
            <MultiSelect label="Repositories" options={list.map((r) => r.name)} value={chosen} autoFocus
              onChange={(next) => setChosen(list.filter((r) => next.includes(r.name)).map((r) => r.name))} />
          ) : (
            <div className="flex flex-col gap-3.5">
              {monorepos.map((r, i) => (
                <div key={r.name} className="flex flex-col gap-1.5">
                  <span className="px-0.5 text-[13px] font-bold text-ink-2">{r.name}</span>
                  <MultiSelect label={`Packages of ${r.name}`} options={r.packages} value={scopes[r.name] ?? []} empty="The whole repository" autoFocus={i === 0}
                    onChange={(next) => setScopes((s) => ({ ...s, [r.name]: r.packages.filter((p) => next.includes(p)) }))} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-6 flex min-h-[34px] items-center gap-4">
        {at > 0 ? <Button variant="link" className="h-auto px-0 text-muted-foreground hover:text-foreground hover:no-underline" onClick={() => go(steps[at - 1] as Step)}>Back</Button> : null}
        <span className="min-w-0 flex-1 text-[13px] wrap-anywhere text-destructive" role="alert">{error ?? ''}</span>
        <Button data-go="true" size="lg" className="px-3.5" disabled={!ready || busy} onClick={forward}>
          {busy ? <><Spinner />Creating</> : <>{last ? 'Create' : 'Next'}<Kbd className="bg-transparent text-current opacity-60">↵</Kbd></>}
        </Button>
      </div>
    </div>
  );
}
