import { describe, expect, it } from 'vitest';
import type { TaskSummary } from './api';
import { parseRoute, type TaskRoute } from './route';
import { nextStop, taskStops } from './stops';

const task = (agents: number, branch: boolean): TaskSummary =>
  ({ id: 't1', agents: Array.from({ length: agents }, (_, i) => [`a${i}`, `https://agent/${i}`]), repos: [{ name: 'web', branch: null, earlier: [], abandoned: [] }, { name: 'api', branch: branch ? 'feat/x' : null, earlier: [], abandoned: [] }] }) as unknown as TaskSummary;
const at = (hash: string): TaskRoute => parseRoute(hash) as TaskRoute;

describe('Tab in a task', () => {
  it('stops at the rows there are, MR at the branch of the first tree on one', () => {
    expect(taskStops(task(1, true), true)).toEqual(['#/t/t1', '#/t/t1/report', '#/t/t1/log', '#/t/t1/agent', '#/t/t1/b/1/changes']);
    expect(taskStops(task(0, false), false)).toEqual(['#/t/t1', '#/t/t1/log']);
    expect(taskStops(task(0, true), false, true)).toEqual(['#/t/t1', '#/t/t1/log', '#/t/t1/b/1/changes', '#/t/t1/resources']);
  });

  it('goes down and round, and back up and round', () => {
    const stops = taskStops(task(2, true), false);
    expect(nextStop(stops, at('#/t/t1'), false)).toBe('#/t/t1/log');
    expect(nextStop(stops, at('#/t/t1/log'), false)).toBe('#/t/t1/agent');
    expect(nextStop(stops, at('#/t/t1/b/1/changes'), false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1'), true)).toBe('#/t/t1/b/1/changes');
  });

  it('goes on from MR to Resources, and round from there to Overview', () => {
    const stops = taskStops(task(1, true), false, true);
    expect(nextStop(stops, at('#/t/t1/b/1/changes'), false)).toBe('#/t/t1/resources');
    expect(nextStop(stops, at('#/t/t1/resources'), false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1'), true)).toBe('#/t/t1/resources');
  });

  it('takes any branch shown for MR, and an artifact for none', () => {
    const stops = taskStops(task(1, true), true);
    expect(nextStop(stops, at('#/t/t1/b/1/feat%2Fold/commits'), false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1/a/uat/d1.png'), false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1/a/uat/d1.png'), true)).toBe('#/t/t1/b/1/changes');
  });
});
