import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

/** What the card is showing: yan as it is, a check under way, its outcome, updates to take, or an update. */
type Card =
  | { readonly is: 'idle' }
  | { readonly is: 'checking' }
  | { readonly is: 'none' }
  | { readonly is: 'unchecked' }
  | { readonly is: 'behind'; readonly n: number }
  | { readonly is: 'updating'; readonly progress: Progress };

/** A ring of dashes, turning: a step under way. */
const Ring = () => (
  <svg className="ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /></svg>
);

/**
 * yan updating itself, a card at the foot of the task list. It says which
 * commit yan is on; a click on 检查 asks how many it is behind, the card
 * saying it is checking and then that there is nothing new; commits to take
 * turn it to how many and a button to take them; taking them, it grows to
 * the steps as a bar, until serve restarts on the new build and the page
 * reloads with it. Its height follows what it holds, with a spring.
 */
export function UpdateCard() {
  const [card, setCard] = useState<Card>({ is: 'idle' });
  const [head, setHead] = useState('');
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  // The commit yan is on, and an update already running, from this page or another.
  useEffect(() => {
    void getJSON<{ head: string }>('/api/yan').then((y) => setHead(y.head), () => undefined);
    void getJSON<Progress>('/api/yan/update').then((p) => {
      if (p.running) setCard({ is: 'updating', progress: p });
    }, () => undefined);
  }, []);

  // While it runs, it is asked again each second. A serve that knows of no update begun is the new build, restarted
  // on: the page reloads with it then, rather than show for a moment what it showed before the update.
  const running = card.is === 'updating' && card.progress.running;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void getJSON<Progress>('/api/yan/update').then((p) => {
      if (!p.steps.some((s) => s.state !== 'wait')) return location.reload();
      setCard({ is: 'updating', progress: p });
    }, () => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // What a check came to goes back to yan as it is after a while.
  useEffect(() => {
    if (card.is !== 'none' && card.is !== 'unchecked') return;
    const timer = window.setTimeout(() => setCard({ is: 'idle' }), card.is === 'none' ? 3000 : 5000);
    return () => window.clearTimeout(timer);
  }, [card.is]);

  // The card's height follows what it holds, so a change of it springs rather than jumps.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const sized = new ResizeObserver(() => setHeight(el.offsetHeight));
    sized.observe(el);
    return () => sized.disconnect();
  }, []);

  const check = (): void => {
    setCard({ is: 'checking' });
    void getJSON<Behind>('/api/yan/updates').then((b) => {
      setCard('error' in b ? { is: 'unchecked' } : b.behind === 0 ? { is: 'none' } : { is: 'behind', n: b.behind });
    }, () => setCard({ is: 'unchecked' }));
  };
  const update = (): void => {
    void postJSON<Progress>('/api/yan/update', {}).then((p) => setCard({ is: 'updating', progress: p }), () => setCard({ is: 'unchecked' }));
  };

  let tone = '';
  let icon: ReactNode = <Icon name="arrowUp" size={15} width={2.1} />;
  let title: ReactNode = 'yan';
  let sub: ReactNode = head;
  let action: ReactNode = <button type="button" className="update-link" onClick={check}>检查</button>;
  let below: ReactNode = null;
  // What a check is doing, or came to, takes the place of 检查 on the right; yan and its commit stay as they are.
  if (card.is === 'checking') {
    [tone, icon, action] = ['on', <Ring key="r" />, <span className="update-state on">检查中…</span>];
  } else if (card.is === 'none') {
    [tone, icon, action] = ['ok', <Icon key="t" name="tick" size={15} width={2.2} />, <span className="update-state ok">无更新</span>];
  } else if (card.is === 'unchecked') {
    tone = 'bad';
    action = <button type="button" className="update-link bad" onClick={check}>检查失败</button>;
  } else if (card.is === 'behind') {
    [tone, title, sub] = ['on', `${card.n} 个更新`, null];
    action = <button type="button" className="button" onClick={update}>更新</button>;
  } else if (card.is === 'updating') {
    const { steps, running: going } = card.progress;
    const failed = steps.findIndex((s) => s.state === 'failed');
    const at = failed >= 0 ? failed : Math.max(0, steps.findIndex((s) => s.state === 'now'));
    const step = steps[at]?.step ?? 'pull';
    tone = failed >= 0 ? 'bad' : 'on';
    icon = failed >= 0 ? <Icon name="close" size={14} width={2.2} /> : <Ring />;
    title = failed >= 0 ? '更新失败' : '更新中';
    // The bar says how far along; the line says only which step.
    sub = STEP_WORD[step];
    action = !going && failed >= 0 ? <button type="button" className="button" onClick={update}>重试</button> : null;
    below = <div className="update-bar">{steps.map((s) => <i key={s.step} className={s.state} />)}</div>;
  }

  return (
    <div className="update-card" style={height === undefined ? undefined : { height }}>
      <div ref={inner} className={`update-inner ${card.is}`}>
        <div className="update-row" key={card.is}>
          <span className={`update-icon ${tone}`}>{icon}</span>
          <span className="update-words">
            <b>{title}</b>
            {sub ? <span className={card.is === 'updating' ? tone : undefined}>{sub}</span> : null}
          </span>
          {action}
        </div>
        {below}
      </div>
    </div>
  );
}
