import { describe, expect, it } from 'vitest';
import type { TaskSummary } from './api';
import { parseRoute, type TaskRoute } from './route';
import { goesOn, nextStop, taskStops } from './stops';

const task = (agents: number, branch: boolean): TaskSummary =>
  ({ id: 't1', agents: Array.from({ length: agents }, (_, i) => [`a${i}`, `https://agent/${i}`]), repos: [{ name: 'web', branch: null, earlier: [], abandoned: [] }, { name: 'api', branch: branch ? 'feat/x' : null, earlier: [], abandoned: [] }] }) as unknown as TaskSummary;
const at = (hash: string): TaskRoute => parseRoute(hash) as TaskRoute;

describe('Tab in a task', () => {
  it("stops at the rows there are, each at its own page, MR's for a branch or a merge request", () => {
    expect(taskStops(task(1, true), { report: true })).toEqual(['#/t/t1', '#/t/t1/report', '#/t/t1/log', '#/t/t1/agent', '#/t/t1/mr']);
    expect(taskStops(task(0, false))).toEqual(['#/t/t1', '#/t/t1/log']);
    expect(taskStops(task(0, true), { resources: true })).toEqual(['#/t/t1', '#/t/t1/log', '#/t/t1/mr', '#/t/t1/resources']);
    expect(taskStops(task(1, false), { terminal: true }), 'a terminal after Log').toEqual(['#/t/t1', '#/t/t1/log', '#/t/t1/terminal', '#/t/t1/agent']);
    expect(taskStops(task(0, false), { mergeRequests: true }), 'a merge request with no branch kept').toEqual(['#/t/t1', '#/t/t1/log', '#/t/t1/mr']);
  });

  it('starts the agent again only for a task still open or handed over to be accepted', () => {
    const as = (state: string): TaskSummary => ({ ...task(0, false), state }) as unknown as TaskSummary;
    expect(['open', 'uat', 'done', 'abandoned'].map((s) => goesOn(as(s)))).toEqual([true, true, false, false]);
  });

  it('goes down and round, and back up and round', () => {
    const stops = taskStops(task(2, true));
    expect(nextStop(stops, at('#/t/t1'), false)).toBe('#/t/t1/log');
    expect(nextStop(stops, at('#/t/t1/log'), false)).toBe('#/t/t1/agent');
    expect(nextStop(stops, at('#/t/t1/mr'), false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1'), true)).toBe('#/t/t1/mr');
  });

  it('goes on from MR to Resources, and round from there to Overview', () => {
    const stops = taskStops(task(1, true), { resources: true });
    expect(nextStop(stops, at('#/t/t1/mr'), false)).toBe('#/t/t1/resources');
    expect(nextStop(stops, at('#/t/t1/resources'), false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1'), true)).toBe('#/t/t1/resources');
  });

  it('takes any branch shown for MR, which it was opened from, and an artifact for none', () => {
    const stops = taskStops(task(1, true), { report: true, resources: true });
    expect(nextStop(stops, at('#/t/t1/b/1/feat%2Fold/commits'), false)).toBe('#/t/t1/resources');
    expect(nextStop(stops, at('#/t/t1/b/1/changes'), true)).toBe('#/t/t1/agent');
    expect(nextStop(stops, at('#/t/t1/a/uat/d1.png'), false)).toBe('#/t/t1');
    expect(nextStop(stops, at('#/t/t1/a/uat/d1.png'), true)).toBe('#/t/t1/resources');
  });
});
