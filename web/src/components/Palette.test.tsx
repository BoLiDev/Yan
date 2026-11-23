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
    expect(options.length).toBe(2);
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
    expect(location.hash).toBe('#/');
  });

  it('offers, with nothing typed, the tasks visited last, then the open ones', async () => {
    useUI.setState({ recent: ['t2'] });
    const screen = await draw(<Palette />);
    const names = screen.getByRole('option').elements().map((el) => el.textContent ?? '');
    expect(names).toEqual([expect.stringMatching(/^export csv/), expect.stringMatching(/^login page/)]);
  });

  it('leaves out the tasks done or given up, one visited last among them, until Tab or its button brings them in, and again takes them out', async () => {
    useUI.setState({ recent: ['t3'] });
    const screen = await draw(<Palette />);
    const names = (): string[] => screen.getByRole('option').elements().map((el) => (el.textContent ?? '').replace(/t\d.*$/, ''));
    expect(names()).toEqual(['login page', 'export csv']);
    await screen.getByRole('combobox', { name: 'Go to a task' }).fill('dark');
    await expect.element(screen.getByText(/Tab looks among the closed ones/)).toBeVisible();

    await userEvent.keyboard('{Tab}');
    await expect.poll(names).toEqual(['dark mode']);
    await expect.element(screen.getByRole('combobox', { name: 'Go to a task' })).toHaveFocus();
    await screen.getByRole('button', { name: /Closed too/ }).click();
    await expect.poll(names).toEqual([]);
    await screen.getByRole('button', { name: /Closed too/ }).click();
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe('#/t/t3');
  });

  it('says so when nothing matches, and Escape closes it', async () => {
    const screen = await draw(<Palette />);
    await screen.getByRole('combobox', { name: 'Go to a task' }).fill('zzzz');
    await expect.element(screen.getByText(/^No open task matches/)).toBeVisible();
    await userEvent.keyboard('{Tab}');
    await expect.element(screen.getByText('No task matches', { exact: true })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(useUI.getState().palette).toBe(false);
  });
});
