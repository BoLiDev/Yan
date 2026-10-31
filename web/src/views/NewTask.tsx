import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJSON, type Index, type TerminalState } from '../lib/api';
import { link } from '../lib/route';
import { AntIcon, Icon } from '../components/Icon';
import { Pane } from '../components/ui';
import { pullNow, queryClient } from '../state/server';
import { toast } from '../state/ui';
import { TerminalView } from './Terminal';
import { useKeyNav } from './nav';

/** A repository a new task may work in, as serve offers it, with its packages when it has several. */
interface RepoOption {
  readonly name: string;
  readonly packages: readonly string[];
}

/**
 * A new task, asked here what bare `yan` would ask at a terminal: its title,
 * the repositories it works in, and for one with several packages, which it
 * is about (the whole repository unless some are picked). Created, it is
 * bare `yan` in a new herdr tab given those answers, which the right column
 * shows as it makes the task and its trees and starts the agent; the form
 * stays as it was sent.
 */
export function NewTaskForm({ launch, state }: { launch: string | undefined; state: TerminalState | undefined }) {
  const { data: repos } = useQuery({ queryKey: ['launch-repos'], queryFn: () => getJSON<RepoOption[]>('/api/launch/repos'), staleTime: 30_000 });
  const [title, setTitle] = useState('');
  // Each repository picked, with its packages: `[]` for the whole of it.
  const [picked, setPicked] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [busy, setBusy] = useState(false);
  const sent = launch !== undefined;
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!sent) field.current?.focus();
  }, [sent]);

  const toggle = (name: string): void => setPicked((p) => {
    const { [name]: was, ...rest } = p;
    return was === undefined ? { ...p, [name]: [] } : rest;
  });
  // A package picked narrows the repository to the packages picked; the whole repository drops them.
  const scope = (name: string, pkg: string | null): void => setPicked((p) => {
    const was = p[name] ?? [];
    if (pkg === null) return { ...p, [name]: [] };
    return { ...p, [name]: was.includes(pkg) ? was.filter((x) => x !== pkg) : [...was, pkg] };
  });

  const create = async (): Promise<void> => {
    if (title.trim() === '' || busy || sent) return;
    setBusy(true);
    try {
      const r = await fetch('/api/launch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), repos: Object.entries(picked).map(([name, s]) => ({ name, scope: s })) }),
      });
      if (!r.ok) return void toast(`没能创建：${(await r.text()) || r.status}`);
      const { launch: made } = (await r.json()) as { launch: string };
      await queryClient.invalidateQueries({ queryKey: ['terminals'] });
      location.hash = link.new(made);
    } catch (err) {
      toast(`没能创建：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const shownTitle = sent && title === '' ? (state?.title ?? '') : title;
  const form = (
      <form className="new-task" onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}>
        <label className="new-field">
          <span className="label">标题</span>
          <input ref={field} className="new-title" value={shownTitle} disabled={sent || busy} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {repos !== undefined && repos.length > 0 ? (
          <div className="new-field">
            <span className="label">仓库</span>
            <div className="new-repos">
              {repos.map((repo) => {
                const on = picked[repo.name];
                return (
                  <div key={repo.name} className="new-repo">
                    <button type="button" className={'row' + (on !== undefined ? ' on' : '')} aria-pressed={on !== undefined} disabled={sent || busy} onClick={() => toggle(repo.name)}>
                      <Icon name="branch" size={16} />
                      <span className="grow">{repo.name}</span>
                      {on !== undefined ? <span className="new-tick"><AntIcon name="check" size={13} /></span> : null}
                    </button>
                    {on !== undefined && repo.packages.length > 0 ? (
                      <div className="new-packages">
                        <button type="button" className={'chip' + (on.length === 0 ? ' on' : '')} aria-pressed={on.length === 0} disabled={sent || busy} onClick={() => scope(repo.name, null)}>整个仓库</button>
                        {repo.packages.map((pkg) => (
                          <button key={pkg} type="button" className={'chip' + (on.includes(pkg) ? ' on' : '')} aria-pressed={on.includes(pkg)} disabled={sent || busy} onClick={() => scope(repo.name, pkg)}>{pkg}</button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <button type="submit" className="button new-go" disabled={sent || busy || title.trim() === ''}>{sent ? '已创建' : busy ? '创建中…' : '创建'}</button>
      </form>
  );
  return <Pane top={<div className="task-head"><div className="t"><h1>新建 task</h1></div></div>} body={form} />;
}

/**
 * A new task's terminal: its herdr tab, bare `yan` making the task and its
 * trees, then the agent. Once bare `yan` keeps the pane as the task's and the
 * task, pushed, is in the index, the page is the task's own Terminal, the
 * same pane.
 */
export function LaunchView({ launch, state, index }: { launch: string | undefined; state: TerminalState | undefined; index: Index }) {
  useKeyNav(null, null);
  const task = state?.task;
  const listed = task !== undefined && index.tasks.some((t) => t.id === task);
  useEffect(() => {
    if (task !== undefined && listed) location.replace(link.terminal(task));
  }, [task, listed]);
  // bare yan pushes the task it made before the agent starts; serve is asked to fetch it until it shows it.
  useEffect(() => {
    if (task === undefined || listed) return;
    void pullNow();
    const again = window.setInterval(() => void pullNow(), 3000);
    return () => window.clearInterval(again);
  }, [task, listed]);
  if (launch === undefined) return <div className="new-waiting" />;
  return <TerminalView id={launch} state={state} waiting />;
}
