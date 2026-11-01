import { describe, expect, it } from 'vitest';
import { AgentWatch } from './agent-watch.js';

describe('an agent watched', () => {
  it('has no change at first sight, then the change it makes and when, kept while it stays', () => {
    const w = new AgentWatch();
    expect(w.note('t1', 'working', 100)).toBeUndefined();
    expect(w.note('t1', 'working', 105)).toBeUndefined();
    expect(w.note('t1', 'done', 110)).toEqual({ from: 'working', to: 'done', at: 110 });
    expect(w.note('t1', 'done', 200)).toEqual({ from: 'working', to: 'done', at: 110 });
    expect(w.note('t1', 'idle', 210)).toEqual({ from: 'done', to: 'idle', at: 210 });
  });

  it('takes herdr not knowing for a moment as no change', () => {
    const w = new AgentWatch();
    w.note('t1', 'working', 100);
    expect(w.note('t1', 'unknown', 105)).toBeUndefined();
    expect(w.note('t1', 'working', 110)).toBeUndefined();
    expect(w.note('t1', 'blocked', 120)).toEqual({ from: 'working', to: 'blocked', at: 120 });
  });

  it('forgets an agent whose pane has gone, so one started again begins afresh', () => {
    const w = new AgentWatch();
    w.note('t1', 'working', 100);
    w.note('t1', 'done', 110);
    w.keep(new Set());
    expect(w.note('t1', 'idle', 300)).toBeUndefined();
  });
});
