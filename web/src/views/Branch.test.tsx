import { afterEach, describe, expect, it } from 'vitest';
import type { BranchRoute } from '../lib/route';
import { useUI } from '../state/ui';
import { draw, have, index, reset, serve, task } from '../testing/serve';
import { BranchView } from './Branch';

const t = task('t1', 'pay retries');
const at = (name: string): BranchRoute => ({ view: 'task', id: 't1', sub: 'branch', repo: 0, name, tab: 'changes', item: '' });
/** serve's answer for a branch it cannot show, which is all these tests need drawn. */
const none = (branch: string): Response => Response.json({ repo: 'demo', url: 'u', branch, clone: null, fetchedAt: null, fetchError: null, target: 'main', base: '', head: '', merged: null, ahead: 0, behind: 0, links: { pr: null, compare: null, branch: null, forge: null }, commits: [], files: [], missing: `${branch} is not on origin` });

describe("a task's branch on the page", () => {
  afterEach(reset);

  it('is fetched from origin afresh each time it is gone to, and not again while it is looked at', async () => {
    const asked = serve({ '/api/branch': ({ query }) => none(query.get('branch') ?? '') });
    have(index([t]));
    const fresh = (): string[] => asked.filter((a) => a.path === '/api/branch' && a.query.get('fresh') === '1').map((a) => a.query.get('branch') ?? '');
    const screen = await draw(<BranchView t={t} r={at('feat/retry')} />);
    await expect.element(screen.getByText('feat/retry is not on origin')).toBeVisible();
    await expect.poll(fresh).toEqual(['feat/retry']);

    // Another of its tabs is the same branch still.
    await screen.rerender(<BranchView t={t} r={{ ...at('feat/retry'), tab: 'commits' }} />);
    await screen.rerender(<BranchView t={t} r={at('feat/other')} />);
    await expect.poll(fresh).toEqual(['feat/retry', 'feat/other']);
  });

  it('is asked for as this machine has it once that is what is shown, afresh, and as origin has it again after', async () => {
    const asked = serve({ '/api/branch': ({ query }) => none(query.get('branch') ?? '') });
    have(index([t]));
    const whose = (): string[] => asked.filter((a) => a.path === '/api/branch' && a.query.get('fresh') === '1').map((a) => (a.query.get('local') === '1' ? 'local' : 'origin'));
    await draw(<BranchView t={t} r={at('feat/retry')} />);
    await expect.poll(whose).toEqual(['origin']);
    useUI.setState({ branchLocal: true });
    await expect.poll(whose).toEqual(['origin', 'local']);
    useUI.setState({ branchLocal: false });
    await expect.poll(whose).toEqual(['origin', 'local', 'origin']);
  });
});
