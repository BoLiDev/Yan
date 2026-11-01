import { afterEach, describe, expect, it } from 'vitest';
import { detail, draw, have, index, reset, serve, task } from '../../testing/serve';
import { Right } from '../../panes/Right';

describe("a task's terminal", () => {
  afterEach(reset);

  it('gives way to the overview of a closed task once serve has no terminal for it, the closing it showed over', async () => {
    serve({ '/api/terminals': Response.json({}) });
    have(index([task('t2', 'old work', { state: 'done', closedAt: '2026-11-01T10:00:00Z' })]), [detail('t2', { state: 'done' })]);
    history.replaceState(null, '', '#/t/t2/terminal');
    await draw(<Right />);
    await expect.poll(() => location.hash).toBe('#/t/t2');
  });

  it("stays on an open task's, which Continue starts again", async () => {
    serve({ '/api/terminals': Response.json({}) });
    have(index([task('t1', 'pay retries')]), [detail('t1')]);
    history.replaceState(null, '', '#/t/t1/terminal');
    const screen = await draw(<Right />);
    await expect.element(screen.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(location.hash).toBe('#/t/t1/terminal');
  });
});
