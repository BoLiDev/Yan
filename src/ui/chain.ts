import { styleText } from 'node:util';
import { log, outro, spinner } from '@clack/prompts';

/**
 * What bare `yan` says between its questions and the agent, on the same
 * Clack chain the questions are on, so the launch reads as one run of steps
 * and ends with the chain's `└`. Asks nothing; imported dynamically, like
 * prompts.ts, so a command that never launches never loads Clack.
 */

/** How a step came out: done, worth knowing, or done in a way worth a second look. */
export type StepKind = 'done' | 'info' | 'warn';

/** One line on the chain, with dimmed lines under it. */
export interface Said {
  readonly kind: StepKind;
  readonly line: string;
  readonly detail?: readonly string[];
}

/** A step that takes a while: a spinner saying what is being done, until it says what was. */
export interface Working {
  update(doing: string): void;
  finish(said: Said): void;
}

function symbol(kind: StepKind): string {
  if (kind === 'warn') return styleText('yellow', '▲');
  if (kind === 'info') return styleText('blue', '●');
  return styleText('green', '◇');
}

function write(said: Said, spacing: number): void {
  const detail = (said.detail ?? []).map((d) => styleText('dim', d));
  log.message([said.line, ...detail], { symbol: symbol(said.kind), spacing });
}

export function working(doing: string): Working {
  const s = spinner();
  s.start(doing);
  return {
    update: (next) => s.message(next),
    finish: (said) => {
      // The spinner has already drawn the bar above it; the line takes its place.
      s.clear();
      write(said, 0);
    },
  };
}

export function say(said: Said): void {
  write(said, 1);
}

export function end(line: string): void {
  outro(line);
}
