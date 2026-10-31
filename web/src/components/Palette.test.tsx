import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { draw, have, index, reset, task } from '../testing/serve';
import { useUI } from '../state/ui';
import { Palette } from './Palette';

const tasks = [
  task('t1', 'login page', { touched: 3 }),
  task('t2', 'export csv', { touched: 2, agents: [['cloud', 'https://agent.example/t2']] }),
  task('t3', 'dark mode', { state: 'done', touched: 1 }),
];

describe('⌘K', () => {
  beforeEach(() => {
    have(index(tasks));
    useUI.setState({ palette: true });
  });
  afterEach(reset);

  it('goes to the best match of what is typed with Enter, and closes', async () => {
    const screen = await draw(<Palette />);
    await screen.getByRole('combobox', { name: 'Go to a task' }).fill('csv');
    await expect.poll(() => screen.getByRole('option', { selected: true }).element().textContent).toMatch(/^export csv/);
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe('#/t/t2');
    expect(useUI.getState().palette).toBe(false);
  });

  it('moves the pick with the arrows, and Enter goes to the one picked', async () => {
    const screen = await draw(<Palette />);
    await screen.getByRole('combobox', { name: 'Go to a task' }).fill('o');
    await userEvent.keyboard('{ArrowDown}');
    const options = screen.getByRole('option').elements();
    expect(options.length).toBe(3);
    const picked = options.findIndex((el) => el.getAttribute('aria-selected') === 'true');
    expect(picked).toBe(1);
    const id = /t\d/.exec(options[picked]?.textContent ?? '')?.[0];
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe(`#/t/${id}`);
  });

  it("opens the picked task's agent in the agent tab with the modifier and Enter", async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const screen = await draw(<Palette />);
    await screen.getByRole('combobox', { name: 'Go to a task' }).fill('csv');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(opened).toHaveBeenCalledWith('https://agent.example/t2', 'yan-agent');
    expect(location.hash).toBe('#/latest');
  });

  it('offers, with nothing typed, the tasks visited last, then the open ones', async () => {
    useUI.setState({ recent: ['t3'] });
    const screen = await draw(<Palette />);
    const names = screen.getByRole('option').elements().map((el) => el.textContent ?? '');
    expect(names).toEqual([expect.stringMatching(/^dark mode/), expect.stringMatching(/^login page/), expect.stringMatching(/^export csv/)]);
  });

  it('says so when nothing matches, and Escape closes it', async () => {
    const screen = await draw(<Palette />);
    await screen.getByRole('combobox', { name: 'Go to a task' }).fill('zzzz');
    await expect.element(screen.getByText('No task matches')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(useUI.getState().palette).toBe(false);
  });
});
