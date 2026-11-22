import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('offer the fonts installed on this computer, and the page is written in the one picked, kept in this browser', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [{ family: 'Georgia' }, { family: 'Courier New' }, { family: 'Courier New' }, { family: 'Arial' }]);
    const { screen, box } = await settings();
    await box.getByRole('combobox', { name: 'Font', exact: true }).click();
    await expect.poll(() => screen.getByRole('option').elements().length).toBe(3);
    await box.getByRole('combobox', { name: 'Font', exact: true }).fill('geor');
    await screen.getByRole('option', { name: 'Georgia' }).click();
    expect(getComputedStyle(document.body).fontFamily).toMatch(/^"?Georgia"?, /);
    expect(kept().font).toBe('Georgia');
    expect(kept().termFont).toBe('');
  });

  it('take several with commas between, in order, a family picked from the list taking the place of the name being typed', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [{ family: 'Georgia' }, { family: 'Courier New' }, { family: 'Arial' }]);
    const { screen, box } = await settings();
    const field = box.getByRole('combobox', { name: 'Font', exact: true });
    await field.fill('Arial ,  monospace, geor');
    await expect.poll(() => screen.getByRole('option').elements().length).toBe(1);
    await screen.getByRole('option', { name: 'Georgia' }).click();
    expect(kept().font).toBe('Arial, monospace, Georgia');
    expect(getComputedStyle(document.body).fontFamily).toMatch(/^"?Arial"?, monospace, "?Georgia"?, /);
  });

  it('take a name typed where the browser lists none, the terminal\'s apart from the page\'s, and go back to yan\'s own when emptied', async () => {
    const { box } = await settings();
    const own = getComputedStyle(document.body).fontFamily;
    const field = box.getByRole('combobox', { name: 'Terminal font' });
    await field.fill('Menlo');
    expect(kept().termFont ?? '').toBe('');
    await field.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect.poll(() => kept().termFont).toBe('Menlo');
    expect(getComputedStyle(document.body).fontFamily).toBe(own);
    await field.fill('');
    await box.getByRole('combobox', { name: 'Font', exact: true }).click();
    await expect.poll(() => kept().termFont).toBe('');
  });
});
