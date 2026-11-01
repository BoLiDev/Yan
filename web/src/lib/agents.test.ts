import { describe, expect, it } from 'vitest';
import type { AgentStatus, TerminalState } from './api';
import { agentNews, markAgentSeen } from './agents';
import type { Seen } from './seen';

const state = (status: AgentStatus, change?: { from: AgentStatus; at: number }): TerminalState => ({
  status, agent: 'claude', cli: 'claude', pane: 'w1:p1', since: '', herdr: '0.9.5', streams: true, layout: { pane: 'w1:p1' },
  ...(change ? { change: { from: change.from, to: status, at: change.at } } : {}),
});
const seen: Seen = { init: 0, tasks: {}, problems: {}, logs: {}, files: {}, agents: {} };

describe('what an agent is up to', () => {
  it('is at work, or waiting on the user, which is news until answered whatever was looked at', () => {
    expect(agentNews('t1', state('working', { from: 'idle', at: 10 }), seen)).toEqual({ kind: 'working', at: 10, news: false });
    const waiting = agentNews('t1', state('blocked', { from: 'working', at: 20 }), { ...seen, agents: { t1: 99 } });
    expect(waiting).toEqual({ kind: 'blocked', at: 20, news: true });
  });

  it('has finished once it stops working or waiting, and that is news until its terminal is looked at after', () => {
    for (const s of [state('done', { from: 'working', at: 30 }), state('idle', { from: 'working', at: 30 }), state('idle', { from: 'blocked', at: 30 })]) {
      expect(agentNews('t1', s, seen)).toEqual({ kind: 'finished', at: 30, news: true });
      const looked = markAgentSeen(seen, 't1', 30);
      expect(looked && agentNews('t1', s, looked).news).toBe(false);
    }
  });

  it('is idle when serve never saw it work, and finished without a time when herdr says done before serve saw it change', () => {
    expect(agentNews('t1', state('idle'), seen)).toEqual({ kind: 'idle', at: null, news: false });
    expect(agentNews('t1', state('done'), seen)).toEqual({ kind: 'finished', at: null, news: true });
    expect(agentNews('t1', state('done'), { ...seen, agents: { t1: 5 } }).news).toBe(false);
  });
});
