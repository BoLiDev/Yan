import { afterEach, describe, expect, it } from 'vitest';
import { draw, reset, serve } from '../testing/serve';
import { UpdateCard } from './Update';

const idle = { running: false, steps: [], error: null };

describe("yan's update card", () => {
  afterEach(reset);

  it('checks when asked, and offers the update it finds', async () => {
    const asked = serve({ 'GET /api/yan/update': Response.json(idle), '/api/yan/updates': Response.json({ behind: 2 }), 'POST /api/yan/update': Response.json({ running: true, steps: [{ step: 'pull', state: 'now' }, { step: 'install', state: 'wait' }, { step: 'build', state: 'wait' }, { step: 'restart', state: 'wait' }], error: null }) });
    const screen = await draw(<UpdateCard />);
    await screen.getByRole('button', { name: 'Check for updates' }).click();
    await expect.element(screen.getByText('A new yan is out')).toBeVisible();
    await screen.getByRole('button', { name: 'Update' }).click();
    await expect.element(screen.getByText('Pulling')).toBeVisible();
    expect(asked.filter((a) => a.method === 'POST').map((a) => a.path)).toEqual(['/api/yan/update']);
  });

  it('says when there is nothing new, and when the check could not be made', async () => {
    serve({ 'GET /api/yan/update': Response.json(idle), '/api/yan/updates': Response.json({ behind: 0 }) });
    const screen = await draw(<UpdateCard />);
    await screen.getByRole('button', { name: 'Check for updates' }).click();
    await expect.element(screen.getByText('Up to date')).toBeVisible();
    serve({ 'GET /api/yan/update': Response.json(idle), '/api/yan/updates': Response.json({ error: 'not a git repository' }) });
    await screen.getByRole('button', { name: 'Check again' }).click();
    await expect.element(screen.getByText('Could not check')).toBeVisible();
  });
});
