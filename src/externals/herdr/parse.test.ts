import { describe, expect, it } from 'vitest';
import { typedInput } from './parse.js';

const RULE = '─'.repeat(60);

/** A Claude Code screen with `body` between the prompt box's rules. */
function screen(...body: string[]): string {
  return [
    '⏺ Reading the brief',
    '',
    RULE,
    ...body,
    RULE,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    '',
  ].join('\n');
}

describe('typedInput', () => {
  it('is empty for a bare prompt', () => {
    expect(typedInput(screen('❯'))).toBe('');
    expect(typedInput(screen('❯   '))).toBe('');
  });

  it('is what user has typed, with the prompt mark stripped', () => {
    expect(typedInput(screen('❯ merge it and'))).toBe('merge it and');
  });

  it('joins a line that wrapped onto the rows below', () => {
    expect(typedInput(screen('❯ first part of a long', '  line that wrapped'))).toBe('first part of a long line that wrapped');
  });

  it('takes the last box on the screen, not an earlier rule pair', () => {
    const earlier = [RULE, '❯ old text scrolled away', RULE, ''].join('\n');
    expect(typedInput(`${earlier}\n${screen('❯')}`)).toBe('');
  });

  it('is undefined when the stretch between the rules is not a prompt box', () => {
    // A permission dialog, a /btw overlay, a transcript viewer: something else
    // sits between the last two rules, and there is nothing to wait for.
    expect(typedInput(screen('  Do you want to proceed?', '  ❯ 1. Yes', '    2. No'))).toBeUndefined();
  });

  it('is undefined when no rules frame anything', () => {
    expect(typedInput('$ ')).toBeUndefined();
    expect(typedInput('')).toBeUndefined();
    expect(typedInput(`${RULE}\n❯`)).toBeUndefined();
  });
});
