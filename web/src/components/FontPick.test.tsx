import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { followFonts } from '../state/fonts';
import { useUI } from '../state/ui';
import { draw, reset, serve } from '../testing/serve';
import { SettingsModal } from './Settings';

followFonts();

const kept = (): { font?: string; termFont?: string } => JSON.parse(localStorage.getItem('yan.serve.prefs') ?? '{}');

async function settings() {
  serve({ '/api/yan/update': Response.json({ running: false, steps: [], error: null }) });
  useUI.setState({ settings: true });
  const screen = await draw(<SettingsModal />);
  return { screen, box: screen.getByRole('dialog') };
}

describe('the fonts in the settings', () => {
  afterEach(reset);

  it('start from yan\'s own list, and a font installed on this computer, picked, goes before it and the page is written in it, kept in this browser', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [{ family: 'Georgia' }, { family: 'Courier New' }, { family: 'Courier New' }, { family: 'Arial' }]);
    const { screen, box } = await settings();
    const field = box.getByRole('combobox', { name: 'Font', exact: true });
    const own = (field.element() as HTMLInputElement).value;
    expect(own).toMatch(/^Yan Round, .+, sans-serif$/);
    await field.click();
    await expect.poll(() => screen.getByRole('option').elements().length).toBe(3);
    await screen.getByRole('option', { name: 'Georgia' }).click();
    expect(kept().font).toBe(`Georgia, ${own}`);
    expect(getComputedStyle(document.body).fontFamily).toMatch(/^"?Georgia"?, "?Yan Round"?, /);
    expect(kept().termFont).toBe('');
  });

  it('find a font by letters typed in front of the list, and add it there', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [{ family: 'Georgia' }, { family: 'Courier New' }, { family: 'Arial' }]);
    const { screen, box } = await settings();
    const field = box.getByRole('combobox', { name: 'Terminal font' });
    const own = (field.element() as HTMLInputElement).value;
    await field.click();
    await userEvent.keyboard('{Home}cour');
    await expect.poll(() => screen.getByRole('option').elements().length).toBe(1);
    await screen.getByRole('option', { name: 'Courier New' }).click();
    expect(kept().termFont).toBe(`Courier New, ${own}`);
  });

  it('take a list typed, in order, a family picked from those installed taking the place of the name being typed', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [{ family: 'Georgia' }, { family: 'Courier New' }, { family: 'Arial' }]);
    const { screen, box } = await settings();
    const field = box.getByRole('combobox', { name: 'Font', exact: true });
    await field.fill('Arial ,  monospace, geor');
    await expect.poll(() => screen.getByRole('option').elements().length).toBe(1);
    await screen.getByRole('option', { name: 'Georgia' }).click();
    expect(kept().font).toBe('Arial, monospace, Georgia');
    expect(getComputedStyle(document.body).fontFamily).toMatch(/^"?Arial"?, monospace, "?Georgia"?$/);
  });

  it('take names typed where the browser lists none, the terminal\'s apart from the page\'s, and go back to yan\'s own list when emptied', async () => {
    const { box } = await settings();
    const page = getComputedStyle(document.body).fontFamily;
    const field = box.getByRole('combobox', { name: 'Terminal font' });
    const own = (field.element() as HTMLInputElement).value;
    await field.fill('Menlo');
    expect(kept().termFont ?? '').toBe('');
    await field.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect.poll(() => kept().termFont).toBe('Menlo');
    expect(getComputedStyle(document.body).fontFamily).toBe(page);
    await field.fill('');
    await box.getByRole('heading', { name: 'Settings' }).click();
    await expect.poll(() => kept().termFont).toBe('');
    await expect.element(field).toHaveValue(own);
  });
});
