import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { getJSON, postJSON, type Behind, type UpdateState as Progress } from '../lib/api';
import { Icon } from './Icon';

const STEP_WORD: Readonly<Record<Progress['steps'][number]['step'], string>> = { pull: 'Pulling', install: 'Installing', build: 'Building', restart: 'Restarting' };

/** What the card is showing: nothing asked yet, a check under way, its outcome, a new version to take, or an update. */
type Card =
  | { readonly is: 'idle' }
  | { readonly is: 'checking' }
  | { readonly is: 'none' }
  | { readonly is: 'unchecked' }
  | { readonly is: 'behind' }
  | { readonly is: 'updating'; readonly progress: Progress };

/** A ring of dashes, turning: a step under way. */
const Ring = () => (
  <svg className="ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" /></svg>
);

/**
 * yan updating itself, a card at the foot of the task list: a title saying
 * what it is doing, and on its right 检查 or, once asked, a tile saying where
 * the update is, which is the button to its next move: a tick to check
 * again, an arrow to take a new version, a red turn to try again. Taking
 * one, the title is the step under way and a bar below says how far along,
 * until serve restarts on the new build and the page reloads with it. Its
 * height follows what it holds, with a spring.
 */
export function UpdateCard() {
  const [card, setCard] = useState<Card>({ is: 'idle' });
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  // An update already running, from this page or another.
  useEffect(() => {
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

  // What a check came to goes back to 检查 after a while.
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
      setCard('error' in b ? { is: 'unchecked' } : b.behind === 0 ? { is: 'none' } : { is: 'behind' });
    }, () => setCard({ is: 'unchecked' }));
  };
  const update = (): void => {
    void postJSON<Progress>('/api/yan/update', {}).then((p) => setCard({ is: 'updating', progress: p }), () => setCard({ is: 'unchecked' }));
  };

  // A tile on the right; one with something to do next is its button, named for that alone.
  const tile = (tone: string, icon: ReactNode, does?: [string, () => void]): ReactNode => does
    ? <button type="button" className={`update-tile ${tone}`} aria-label={does[0]} onClick={does[1]}>{icon}</button>
    : <span className={`update-tile ${tone}`}>{icon}</span>;
  const again = <Icon name="reload" size={14} />;

  let title = '';
  let action: ReactNode = null;
  let below: ReactNode = null;
  if (card.is === 'checking') [title, action] = ['Checking', tile('on', <Ring />)];
  else if (card.is === 'none') [title, action] = ['Up to date', tile('ok', <Icon name="tick" size={14} />, ['Check again', check])];
  else if (card.is === 'unchecked') [title, action] = ['Could not check', tile('bad', again, ['Check again', check])];
  else if (card.is === 'behind') [title, action] = ['A new yan is out', tile('on', <Icon name="arrowUp" size={14} />, ['Update', update])];
  else if (card.is === 'updating') {
    const { steps, running: going } = card.progress;
    const failed = steps.findIndex((s) => s.state === 'failed');
    const at = failed >= 0 ? failed : Math.max(0, steps.findIndex((s) => s.state === 'now'));
    const word = STEP_WORD[steps[at]?.step ?? 'pull'];
    // The title is the step; the bar says how far along.
    title = failed >= 0 ? `${word} failed` : word;
    action = failed >= 0 ? tile('bad', again, going ? undefined : ['Try again', update]) : tile('on', <Ring />);
    below = <div className="update-bar">{steps.map((s) => <i key={s.step} className={s.state} />)}</div>;
  }

  return (
    <div className="update-card" style={height === undefined ? undefined : { height }}>
      <div ref={inner} className={`update-inner ${card.is}`}>
        <div className="update-row">
          {/* Nothing asked yet, the card is the one thing to do, Check for updates, across it. Then each part comes in as it
              changes: the title with its words, what is on the right with the card's state. */}
          {card.is === 'idle' ? <button type="button" className="update-check" onClick={check}><Icon name="refresh" size={13} />Check for updates</button> : (
            <>
              <b key={title}>{title}</b>
              <span className="update-action" key={card.is}>{action}</span>
            </>
          )}
        </div>
        {below}
      </div>
    </div>
  );
}
