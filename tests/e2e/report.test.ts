/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, fxGit } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

let served: Served;
let origin = '';

const report = `<!doctype html><html><head><style>.box { display: inline-block; width: 12px; height: 12px; border: 1px solid; }</style></head><body>
<h1 data-yan-edit="title">Pay retries</h1>
<p><span data-yan-progress="">0/2</span></p>
<div data-yan-d="d1" data-yan-status="todo"><span class="box"></span> <span data-yan-edit="text">retries are paid</span> <span data-yan-reason=""></span></div>
<div data-yan-d="d2" data-yan-status="todo"><span class="box"></span> <span data-yan-edit="text">a receipt is sent</span> <span data-yan-reason=""></span></div>
</body></html>`;

beforeAll(async () => {
  const v = await vault((home) => {
    write(home, 'tasks/t001/task.json', taskJson('t001', 'pay retries', {
      nextDeliverable: 3,
      deliverables: [{ id: 'd1', text: 'retries are paid', status: 'todo' }, { id: 'd2', text: 'a receipt is sent', status: 'todo' }],
    }));
    write(home, 'tasks/t001/artifacts/report.html', report);
  });
  origin = v.origin;
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

async function atOrigin(): Promise<{ subject: string; statuses: string[] }> {
  const subject = (await fxGit(['log', '-1', '--format=%s', 'main'], origin)).stdout.trim();
  const doc = JSON.parse((await fxGit(['show', 'main:tasks/t001/task.json'], origin)).stdout) as { deliverables: { status: string }[] };
  return { subject, statuses: doc.deliverables.map((d) => d.status) };
}

describe("checking a task on its report", () => {
  it('ticks a deliverable into a commit at origin, and the report still shows it ticked once that commit is back', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/report'));
    const tick = page.locator('[data-yan-d="d1"] .yan-tick');
    await tick.waitFor();
    // The commit made comes back as the task fetched again, and the report takes it without being drawn again.
    const back = page.waitForResponse((r) => r.url().endsWith('/api/task/t001'), { timeout: 20_000 });
    await tick.click();
    await expect.poll(atOrigin, { timeout: 20_000 }).toEqual({ subject: 't001: d1 done in yan serve', statuses: ['done', 'todo'] });
    await back;
    expect(await page.locator('[data-yan-d="d1"]').getAttribute('data-yan-status')).toBe('done');
    expect(await page.locator('[data-yan-progress]').textContent()).toBe('1/2');
    expect(errors).toEqual([]);
  });

  it('gives one up with its reason, kept in task.json at origin', async () => {
    const { page } = await open(served.url('/#/t/t001/report'));
    await page.locator('[data-yan-d="d2"] .yan-side').click();
    await page.getByRole('dialog', { name: /d2/ }).getByRole('textbox').fill('the receipts service is not ready');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await atOrigin()).statuses, { timeout: 20_000 }).toEqual(['done', 'abandoned']);
    const doc = JSON.parse((await fxGit(['show', 'main:tasks/t001/task.json'], origin)).stdout) as { deliverables: { reason?: string }[] };
    expect(doc.deliverables[1]?.reason).toBe('the receipts service is not ready');
  });
});
