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
/** A step's mark on the line that joins them: done ticked, the one under way a dashed ring turning, the rest open, a failure crossed. */
function Mark({ state }: { state: StepState }) {
  return (
    <svg className="mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {state === 'done' ? <><circle cx="8" cy="8" r="7" /><path d="m4.8 8.3 2.1 2.1 4.3-4.6" /></>
        : state === 'failed' ? <><circle cx="8" cy="8" r="7" /><path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" /></>
          : <circle cx="8" cy="8" r="6.25" />}
    </svg>
  );
}

/** What the chip is doing: waiting to be asked, asking, told there is nothing, failing to ask, or updating. */
type Chip = 'idle' | 'checking' | 'none' | 'failed' | 'running';

/**
 * yan updating itself, beside its name. A click asks how many commits its
 * clone is behind, and the chip says so as it goes, checking and then
 * nothing new; only commits to take open a box, with how many and the one
 * button, and taking them it shows the steps until serve restarts on the
 * new build and the page reloads with it.
 */
export function UpdateYan() {
  const [chip, setChip] = useState<Chip>('idle');
  const [failure, setFailure] = useState('');
  const [behind, setBehind] = useState(0);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const here = useRef<HTMLDivElement>(null);
  const started = progress !== null && progress.steps.some((s) => s.state !== 'wait');

  // An update already running, from this page or another, shows on the chip.
  useEffect(() => {
    void getJSON<Progress>('/api/yan/update').then((p) => {
      setProgress(p);
      if (p.running) setChip('running');
    }, () => undefined);
  }, []);

  // While it runs, it is asked again each second; serve restarting on the new build reloads the page.
  useEffect(() => {
    if (!progress?.running) return;
    const timer = window.setInterval(() => void getJSON<Progress>('/api/yan/update').then((p) => {
      setProgress(p);
      if (!p.running) setChip('idle');
    }, () => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [progress?.running]);

  // What the chip said of a check goes back to the chip after a while.
  useEffect(() => {
    if (chip !== 'none' && chip !== 'failed') return;
    const timer = window.setTimeout(() => setChip('idle'), chip === 'none' ? 3000 : 6000);
    return () => window.clearTimeout(timer);
  }, [chip]);

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

  const check = (): void => {
    if (chip === 'running' || started) return setOpen((o) => !o);
    if (chip === 'checking') return;
    setOpen(false);
    setChip('checking');
    void getJSON<Behind>('/api/yan/updates').then((b) => {
      if ('error' in b) {
        setFailure(b.error);
        setChip('failed');
      } else if (b.behind === 0) setChip('none');
      else {
        setBehind(b.behind);
        setChip('idle');
        setOpen(true);
      }
    }, (err: Error) => {
      setFailure(err.message);
      setChip('failed');
    });
  };
  const update = (): void => {
    void postJSON<Progress>('/api/yan/update', {}).then((p) => {
      setProgress(p);
      setChip('running');
    }, (err: Error) => {
      setFailure(err.message);
      setChip('failed');
      setOpen(false);
    });
  };

  const [icon, word] = chip === 'checking' ? ['spinner', '检查中']
    : chip === 'none' ? ['tick', '无更新']
      : chip === 'failed' ? ['arrowUp', '检查失败']
        : chip === 'running' ? ['spinner', '更新中']
          : open && !started ? ['arrowUp', `${behind} 个更新`] : ['arrowUp', '更新'];
  return (
    <div className="update" ref={here}>
      <button type="button" className={`update-chip ${chip}`} aria-expanded={open} title={chip === 'failed' ? failure : undefined} onClick={check}>
        <span className={icon === 'spinner' ? 'spin' : undefined}><Icon name={icon as 'arrowUp' | 'tick' | 'spinner'} size={13} width={2.2} /></span>{word}
      </button>
      {open ? (
        <div className="update-pop" role="dialog" aria-label="更新 yan">
          {started ? (
            <>
              <div className="update-steps">
                {progress.steps.map((s, i) => (
                  <div key={s.step} className={s.state + (progress.steps[i - 1]?.state === 'done' ? ' after-done' : '')}>
                    <Mark state={s.state} />{STEP_WORD[s.step]}
                  </div>
                ))}
              </div>
              {progress.error ? <pre className="update-error">{progress.error}</pre> : null}
              {!progress.running && progress.error ? <button type="button" className="button" onClick={update}>再试一次</button> : null}
            </>
          ) : (
            <>
              <div className="update-count">{`${behind} 个更新`}</div>
              <button type="button" className="button" onClick={update}>更新</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
