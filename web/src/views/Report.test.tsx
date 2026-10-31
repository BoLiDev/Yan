import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Deliverable, Report } from '../lib/api';
import { detail, draw, have, index, reset, serve, status, task } from '../testing/serve';
import { queryClient } from '../state/server';
import { ReportView } from './Report';

const page = `<!doctype html><html><head><style>body { color: rgb(1, 2, 3); }</style></head><body>
<h1 data-yan-edit="title">Pay retries</h1>
<p>Done <span data-yan-progress="">0/2</span></p>
<div data-yan-d="d1" data-yan-status="todo"><span class="box"></span><span data-yan-edit="text">retries are paid</span><span data-yan-reason=""></span></div>
<div data-yan-d="d2" data-yan-status="todo"><span class="box"></span><span data-yan-edit="text">a receipt is sent</span><span data-yan-reason=""></span></div>
</body></html>`;

const report: Report = { html: page, sha: 'r1', generatedAt: null, behind: [], uat: [] };
const ds = (d1: string, d2: string): Deliverable[] => [
  { id: 'd1', text: 'retries are paid', status: d1, doneAt: null, reason: null },
  { id: 'd2', text: 'a receipt is sent', status: d2, doneAt: null, reason: d2 === 'abandoned' ? 'later' : null },
];
const t = task('t1', 'pay retries');
const wrote = Response.json({ ok: true, warning: null, status: status() });

/** The report as drawn, inside its shadow root. */
const shadow = (): ShadowRoot => document.querySelector('[data-task="t1"]')?.shadowRoot as ShadowRoot;
const progress = (): string | null | undefined => shadow()?.querySelector('[data-yan-progress]')?.textContent;

describe("a task's report", () => {
  beforeEach(() => have(index([t]), [detail('t1', { deliverables: ds('todo', 'todo'), files: [] })]));
  afterEach(reset);

  it('ticks a deliverable, showing it at once and sending it to task.json', async () => {
    const asked = serve({ '/api/report': Response.json(report), 'POST /api/deliverable': wrote });
    await draw(<ReportView t={t} d={detail('t1', { deliverables: ds('todo', 'todo') })} />);
    await expect.poll(() => progress()).toBe('0/2');
    (shadow().querySelector('[data-yan-d="d1"] .yan-tick') as HTMLButtonElement).click();
    expect(progress()).toBe('1/2');
    await expect.poll(() => asked.find((a) => a.method === 'POST')?.body).toEqual({ task: 't1', id: 'd1', to: 'done' });
  });

  it('gives one up only with a reason, and leaves it out of the progress', async () => {
    const asked = serve({ '/api/report': Response.json(report), 'POST /api/deliverable': wrote });
    await draw(<ReportView t={t} d={detail('t1', { deliverables: ds('todo', 'todo') })} />);
    await expect.poll(() => progress()).toBe('0/2');
    (shadow().querySelector('[data-yan-d="d2"] .yan-side') as HTMLButtonElement).click();
    const why = shadow().querySelector<HTMLInputElement>('[role=dialog] input');
    expect(why).not.toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(asked.filter((a) => a.method === 'POST')).toEqual([]);
    await userEvent.keyboard('not this round{Enter}');
    expect(progress()).toBe('0/1');
    await expect.poll(() => asked.find((a) => a.method === 'POST')?.body).toEqual({ task: 't1', id: 'd2', to: 'abandoned', reason: 'not this round' });
  });

  it('saves a text edited where it stands to report.html, against the page it was edited on', async () => {
    const asked = serve({ '/api/report': Response.json(report), 'POST /api/report/edit': wrote });
    await draw(<ReportView t={t} d={detail('t1', { deliverables: ds('todo', 'todo') })} />);
    await expect.poll(() => progress()).toBe('0/2');
    const title = shadow().querySelector<HTMLElement>('[data-yan-edit="title"]') as HTMLElement;
    title.focus();
    getSelection()?.selectAllChildren(title);
    await userEvent.keyboard('Retries, paid{Enter}');
    await expect.poll(() => asked.find((a) => a.path === '/api/report/edit')?.body).toEqual({ task: 't1', sha: 'r1', index: 0, text: 'Retries, paid' });
  });

  it('takes what an agent changed meanwhile without drawing the report again', async () => {
    serve({ '/api/report': Response.json(report) });
    const screen = await draw(<ReportView t={t} d={detail('t1', { deliverables: ds('todo', 'todo') })} />);
    await expect.poll(() => progress()).toBe('0/2');
    const before = shadow().querySelector('[data-yan-d="d1"]');
    await screen.rerender(<ReportView t={t} d={detail('t1', { deliverables: ds('done', 'abandoned') })} />);
    expect(shadow().querySelector('[data-yan-d="d1"]')).toBe(before);
    expect(before?.getAttribute('data-yan-status')).toBe('done');
    expect(shadow().querySelector('[data-yan-d="d2"] [data-yan-reason]')?.textContent).toBe('later');
    expect(progress()).toBe('1/1');
    expect(queryClient.getQueryData(['report', 't1'])).toEqual(report);
  });
});
