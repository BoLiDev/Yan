import { afterEach, describe, expect, it } from 'vitest';
import { draw, index, reset, status, task } from '../testing/serve';
import { TaskInfo } from './TaskInfo';

describe('what yan keeps of a task itself', () => {
  afterEach(reset);

  it('opens from the mark after its title, and says which vault it is in and whether that vault is local or remote', async () => {
    const vaults = [{ name: 'team', dir: '/vaults/team', local: false, origin: true, ok: true, fileLink: null }, { name: 'work', dir: '/vaults/work', local: true, origin: true, ok: true, fileLink: null }];
    const ix = { ...index([task('t5', 'kept at work', { vault: 'work' }), task('t1', 'the team\'s', { vault: 'team' })]), status: { ...status(), vaults } };
    const screen = await draw(<TaskInfo t={ix.tasks[0]!} index={ix} />);
    await screen.getByRole('button', { name: 'About this task' }).click();
    const box = screen.getByRole('dialog');
    await expect.element(box.getByText('work', { exact: true })).toBeVisible();
    await expect.element(box.getByText('Local', { exact: true })).toBeVisible();
    await expect.element(box.getByText('/vaults/work/tasks/t5')).toBeVisible();
  });

  it('says a task of a vault shared through its origin is remote', async () => {
    const ix = { ...index([task('t1', 'shared')]), status: { ...status(), vaults: [{ name: 'fixture', dir: '/vault', local: false, origin: true, ok: true, fileLink: null }] } };
    const screen = await draw(<TaskInfo t={ix.tasks[0]!} index={ix} />);
    await screen.getByRole('button', { name: 'About this task' }).click();
    await expect.element(screen.getByRole('dialog').getByText('Remote', { exact: true })).toBeVisible();
  });
});
