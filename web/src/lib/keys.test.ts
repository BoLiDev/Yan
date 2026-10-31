import { describe, expect, it } from 'vitest';
import { keyFor } from './keys';

const press = (key: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
  keyFor({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });

describe('a key typed into a terminal', () => {
  it('is sent by herdr\'s name when herdr has one, its modifiers before it', () => {
    expect(press('Enter')).toBe('enter');
    expect(press('Enter', { shiftKey: true })).toBe('shift+enter');
    expect(press('Tab', { shiftKey: true })).toBe('shift+tab');
    expect(press('Escape')).toBe('esc');
    expect(press('ArrowUp', { altKey: true })).toBe('alt+up');
    expect(press('c', { ctrlKey: true })).toBe('ctrl+c');
    expect(press('F5')).toBe('f5');
  });

  it('leaves ⌘ chords to the page and the rest to the terminal\'s own bytes', () => {
    expect(press('k', { metaKey: true })).toBe('browser');
    expect(press('v', { metaKey: true })).toBe('browser');
    expect(press('a')).toBe('typed');
    expect(press('A', { shiftKey: true })).toBe('typed');
    expect(press('Home')).toBe('typed');
    expect(press('å', { altKey: true })).toBe('typed');
    expect(press('Process')).toBe('typed');
  });
});
