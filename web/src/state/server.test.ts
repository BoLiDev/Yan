import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Index, Status } from '../lib/api';
import { pullNow, queryClient } from './server';
import { useUI } from './ui';

const status = (version: number): Status => ({ version, commit: 'c1', checkedAt: 1, pulledAt: 1, ok: true, error: null, everyS: 30, local: false, build: 'b1' });

/** serve as the page's requests find it: each path answered by `routes`, anything else 404. */
function serve(routes: Record<string, () => Response>): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url, 'http://localhost').pathname;
    return routes[path]?.() ?? new Response('not found', { status: 404 });
  });
}

describe('a pull by hand', () => {
  beforeEach(() => {
    // Looking at a task's branch, with the index as serve last said it.
    vi.stubGlobal('location', { hash: '#/t/t1/b/0/changes', reload: vi.fn() });
    queryClient.setQueryData<Index>(['index'], { tasks: [], latest: [], status: status(3), vault: { name: 'v', dir: '/v', fileLink: null, source: { include: [], exclude: [] } }, filesOrigin: '' });
    useUI.setState({ connected: true, pulling: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it('keeps the page connected when serve answers, even when the branch being looked at cannot be read', async () => {
    serve({ '/api/pull': () => Response.json(status(3)), '/api/branch': () => new Response('no clone of that repository on this machine', { status: 404 }) });
    await pullNow();
    expect(useUI.getState()).toMatchObject({ connected: true, pulling: false });
  });

  it('says serve stopped when it does not answer at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await pullNow();
    expect(useUI.getState()).toMatchObject({ connected: false, pulling: false });
  });

  it('puts the branch as serve fetched it afresh where the page reads it', async () => {
    const branch = { repo: 'web', head: 'abc' };
    serve({ '/api/pull': () => Response.json(status(3)), '/api/branch': () => Response.json(branch) });
    await pullNow();
    expect(queryClient.getQueryData(['branch', 't1', 0, ''])).toEqual(branch);
  });
});
