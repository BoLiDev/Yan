import { describe, expect, it } from 'vitest';
import type { TaskSummary } from './api';
import { parseRoute, type TaskRoute } from './route';
import { AGENT_STOP, nextStop, taskStops } from './stops';

const task = (agents: number, branch: boolean): TaskSummary =>
  ({ id: 't1', agents: Array.from({ length: agents }, (_, i) => [`a${i}`, `https://agent/${i}`]), repos: [{ name: 'web', branch: null, earlier: [], abandoned: [] }, { name: 'api', branch: branch ? 'feat/x' : null, earlier: [], abandoned: [] }] }) as unknown as TaskSummary;
const at = (hash: string): TaskRoute => parseRoute(hash) as TaskRoute;

describe('Tab in a task', () => {
  it('stops at the rows there are, MR at the branch of the first tree on one', () => {
    expect(taskStops(task(1, true), true)).toEqual(['#/t/t1', '#/t/t1/report', '#/t/t1/log', AGENT_STOP, '#/t/t1/b/1/changes']);
    expect(taskStops(task(0, false), false)).toEqual(['#/t/t1', '#/t/t1/log']);
  });

  it('goes down and round, and back up and round, through Agent without leaving the page under it', () => {
    const stops = taskStops(task(2, true), false);
    expect(nextStop(stops, at('#/t/t1'), false, false)).toBe('#/t/t1/log');
    expect(nextStop(stops, at('#/t/t1/log'), false, false)).toBe(AGENT_STOP);
    expect(nextStop(stops, at('#/t/t1/log'), true, false), 'Agent marked over the log').toBe('#/t/t1/b/1/changes');
    expect(nextStop(stops, at('#/t/t1/log'), true, true)).toBe('#/t/t1/log');
    expect(nextStop(stops, at('#/t/t1/b/1/changes'), false, false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1'), false, true)).toBe('#/t/t1/b/1/changes');
  });

  it('takes any branch shown for MR, and an artifact for none', () => {
    const stops = taskStops(task(1, true), true);
    expect(nextStop(stops, at('#/t/t1/b/1/feat%2Fold/commits'), false, false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1/a/uat/d1.png'), false, false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1/a/uat/d1.png'), false, true)).toBe('#/t/t1/b/1/changes');
  });
});
