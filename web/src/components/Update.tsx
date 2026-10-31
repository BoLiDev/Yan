import { useEffect, useRef, useState } from 'react';
import { getJSON, postJSON } from '../lib/api';
import { Icon } from './Icon';

type Step = 'pull' | 'install' | 'build' | 'restart';
type StepState = 'wait' | 'now' | 'done' | 'failed';
interface Progress {
  readonly running: boolean;
  readonly steps: readonly { readonly step: Step; readonly state: StepState }[];
  readonly error: string | null;
}
type Behind = { readonly behind: number } | { readonly error: string };

const STEP_WORD: Readonly<Record<Step, string>> = { pull: '拉取代码', install: '安装依赖', build: '构建', restart: '重启' };
const MARK: Readonly<Record<StepState, string>> = { done: '✓', now: '●', wait: '○', failed: '✗' };

/**
 * yan updating itself, beside its name: opened, it asks how many commits
 * its clone is behind and offers to take them; taking them, it shows the
 * steps until serve restarts on the new build and the page reloads with it.
 */
export function UpdateYan() {
  const [open, setOpen] = useState(false);
  const [behind, setBehind] = useState<Behind | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const here = useRef<HTMLDivElement>(null);
  const started = progress !== null && progress.steps.some((s) => s.state !== 'wait');

  // Opened, it asks: an update running, from this page or another, or how far behind the clone is.
  useEffect(() => {
    if (!open) return;
    setBehind(null);
    void getJSON<Progress>('/api/yan/update').then(setProgress, () => undefined);
    void getJSON<Behind>('/api/yan/updates').then(setBehind, (err: Error) => setBehind({ error: err.message }));
  }, [open]);

  // While it runs, it is asked again each second; serve restarting on the new build reloads the page.
  useEffect(() => {
    if (!progress?.running) return;
    const timer = window.setInterval(() => void getJSON<Progress>('/api/yan/update').then(setProgress, () => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [progress?.running]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!here.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const update = (): void => {
    void postJSON<Progress>('/api/yan/update', {}).then(setProgress, (err: Error) => setBehind({ error: err.message }));
  };

  return (
    <div className="update" ref={here}>
      <button type="button" className={'update-chip' + (progress?.running ? ' running' : '')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="arrowUp" size={13} width={2.2} />{progress?.running ? '更新中' : '更新'}
      </button>
      {open ? (
        <div className="update-pop" role="dialog" aria-label="更新 yan">
          {started ? (
            <>
              <div className="update-steps">
                {progress.steps.map((s) => <div key={s.step} className={s.state}><span className="mark">{MARK[s.state]}</span>{STEP_WORD[s.step]}</div>)}
              </div>
              {progress.error ? <pre className="update-error">{progress.error}</pre> : null}
              {!progress.running && progress.error ? <button type="button" className="button" onClick={update}>再试一次</button> : null}
            </>
          ) : behind === null ? (
            <div className="update-said">检查中…</div>
          ) : 'error' in behind ? (
            <pre className="update-error">{behind.error}</pre>
          ) : behind.behind === 0 ? (
            <div className="update-said">已是最新</div>
          ) : (
            <>
              <div className="update-count">{`${behind.behind} 个更新`}</div>
              <button type="button" className="button" onClick={update}>更新</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
