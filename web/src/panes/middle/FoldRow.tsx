import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { ASIDE, GROW } from '../../components/page';
import { cn } from '../../lib/utils';
import { FOLD, SHIMMER, STEP_ROW, WORD, navRow } from './look';

/**
 * A row of the nav that folds the rows under it away: MR, Resources, Agent.
 * It names none of them, and its chevron sits at the very end, where the
 * row's other figures end. The word and the figures stay whole.
 */
export function FoldRow({ icon, word, aside, open, on, shine, onFlip }: {
  icon: IconName;
  word: string;
  aside: ReactNode;
  open: boolean;
  on?: boolean;
  /** The word shimmers: the agent tab shows one of the rows folded under it. */
  shine?: boolean;
  onFlip: () => void;
}) {
  return (
    <button type="button" className={navRow(on)} aria-expanded={open} aria-current={on ? 'page' : undefined} onClick={onFlip}>
      <Icon name={icon} size={16} />
      <span className={cn(WORD, shine && SHIMMER)}>{word}</span>
      <span className={GROW} />
      {aside !== null ? <span className={ASIDE}>{aside}</span> : null}
      <span className={FOLD}><Icon name={open ? 'up' : 'down'} size={15} /></span>
    </button>
  );
}

/** A row a step in that folds the rows under it: a repository under MR, a kind under Resources. */
export function StepRow({ name, aside, open, onFlip }: { name: ReactNode; aside: ReactNode; open: boolean; onFlip: () => void }) {
  return (
    <button type="button" className={STEP_ROW} aria-expanded={open} onClick={onFlip}>
      <span className={GROW}>{name}</span>
      {aside !== null ? <span className={ASIDE}>{aside}</span> : null}
      <span className={FOLD}><Icon name={open ? 'up' : 'down'} size={14} /></span>
    </button>
  );
}
