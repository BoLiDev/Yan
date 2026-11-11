/// <reference lib="dom" />
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Locator, Page } from 'playwright';
import { cleanupTempDirs, runYan } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * A review made of a task's own notes: its problem and its deliverables on
 * the overview, its log, and its report, each commented on where it is
 * read, the comment saying which it is.
 */

let served: Served;
let home = '';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const report = `<!doctype html><html><head><style>body{background:#000;color:#ddd;font:15px/1.7 sans-serif} .wrap{max-width:420px;padding:24px} figure img{width:120px;height:80px;background:#345}</style></head><body><div class="wrap">
<h1 data-yan-edit="title">Pay retries</h1>
<ul><li><span data-yan-edit="approach">Retry a failed payment five times at most, waiting a little longer before each try, and tell the customer to use another card once the tries are spent.</span></li></ul>
<div data-yan-d="d1" data-yan-status="todo"><span class="box"></span> <p class="text" data-yan-edit="text">retries are capped at five</p> <span data-yan-reason=""></span>
<figure><img alt="the retry banner" src="data:image/png;base64,${PNG}"></figure></div>
</div></body></html>`;

beforeAll(async () => {
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries', { deliverables: [{ id: 'd1', text: 'retries are capped at five', status: 'todo' }] }));
    write(dir, 'tasks/t001/problem.md', '# pay retries\n\nA payment is retried forever.\n\nBanks flag the card after a few tries.\n');
    write(dir, 'tasks/t001/log.md', '- 11-08  agreed   cap the retries at five\n- 11-09  changed  backoff doubles each time\n');
    write(dir, 'tasks/t001/artifacts/report.html', report);
  });
  home = v.home;
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

/** Select `word` inside `within` by a double click on it, and right click it. */
async function pick(page: Page, within: Locator, word: string): Promise<void> {
  const box = await within.evaluate((el, w) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
      const i = (n as Text).data.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    throw new Error(`${w} is not there`);
  }, word);
  await page.mouse.dblclick(box.x, box.y);
  await page.mouse.click(box.x, box.y, { button: 'right' });
}

/** Comment `text` from the menu that is open, having checked it says `where`. */
async function comment(page: Page, where: RegExp, text: string): Promise<void> {
  await page.getByRole('menuitem', { name: 'Comment' }).click();
  await page.getByRole('dialog').getByText(where).waitFor();
  await page.getByRole('textbox', { name: 'Comment' }).fill(text);
  await page.keyboard.press('Enter');
  // Gone before anything else is picked: while it closes it is still over the page.
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}

describe("a review of a task's notes", () => {
  it('takes comments on the problem, a deliverable, a log entry and the report, each saying where it is', async () => {
    const { page, errors } = await open(served.url('/#/t/t001'));
    const main = page.getByRole('main');
    await main.getByText('A payment is retried forever.').waitFor();
    await pick(page, main, 'forever');
    await comment(page, /^problem\.md, line 3$/, 'Five times.');
    await pick(page, main.locator('[data-deliverable=d1]'), 'capped');
    await comment(page, /^deliverable d1$/, 'Say who caps them.');

    await page.goto(served.url('/#/t/t001/log'));
    await main.getByText('backoff doubles each time').waitFor();
    await pick(page, main, 'doubles');
    await comment(page, /^log\.md, the changed entry of 11-09$/, 'Up to what?');

    await page.goto(served.url('/#/t/t001/report'));
    await page.locator('[data-yan-d="d1"] [data-yan-edit="text"]').waitFor();
    await pick(page, page.locator('[data-yan-d="d1"] [data-yan-edit="text"]'), 'capped');
    await comment(page, /^artifacts\/report\.html, deliverable d1$/, 'Capped where?');
    await page.locator('figure img').click({ button: 'right' });
    await comment(page, /^artifacts\/report\.html, deliverable d1, the picture "the retry banner"$/, 'Too small to read.');

    await page.getByRole('button', { name: /Review · 5 comments/ }).click();
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByText(/tasks\/t001\/reviews\/.+\.md/).waitFor({ timeout: 20_000 });
    const printed = (await runYan(home, ['review', '--task', 't001'])).stdout;
    for (const said of ['## 1. problem.md, line 3\n\n> forever\n\nFive times.', '## 2. deliverable d1\n\n> capped', '## 3. log.md, the changed entry of 11-09\n\n> doubles', '## 4. artifacts/report.html, deliverable d1\n\n> capped', 'the picture "the retry banner"\n\n> the retry banner\n\nToo small to read.']) {
      expect(printed).toContain(said);
    }
    expect(errors).toEqual([]);
  }, 90_000);

  it('opens the problem to edit with the words selected in it still selected', async () => {
    const { page } = await open(served.url('/#/t/t001'));
    const main = page.getByRole('main');
    await main.getByText('Banks flag the card after a few tries.').waitFor();
    await pick(page, main, 'flag');
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const area = main.getByRole('textbox', { name: 'problem.md' });
    await area.waitFor();
    expect(await area.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('flag');
  }, 60_000);

  it("frames a report's text once while it is edited, however many lines it runs over", async () => {
    const { page } = await open(served.url('/#/t/t001/report'));
    const text = page.locator('[data-yan-edit="approach"]');
    await text.click();
    // The span itself, which a frame would be drawn round line by line, has none; the line it is in has one.
    expect(await text.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    expect(await text.evaluate((el) => getComputedStyle(el.parentElement as Element).outlineStyle)).toBe('solid');
    expect(await text.evaluate((el) => el.getClientRects().length), 'it does run over several lines').toBeGreaterThan(1);
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'report-edit.png') });
  }, 60_000);
});
