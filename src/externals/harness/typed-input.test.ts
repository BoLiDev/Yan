import { describe, expect, it } from 'vitest';
import { typedInput } from './typed-input.js';

const RULE = '─'.repeat(60);

/** A Claude Code screen with `body` between the prompt box's rules. */
function claude(...body: string[]): string {
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

const BG = '\x1b[48;2;45;45;53m';

/**
 * A Codex screen as `agent read --format ansi` gives it: an earlier turn's
 * `›` line in the history, then the composer with `entry` after the marker,
 * `wrapped` under it, and the status line below.
 */
function codex(entry: string, ...wrapped: string[]): string {
  return [
    '› what I asked last time',
    '',
    '• Done.',
    '',
    `\x1b[0m\x1b[1m${BG}›\x1b[0m${BG} ${entry}\x1b[0m`,
    ...wrapped.map((line) => `  ${line}`),
    '',
    '  \x1b[38;2;246;226;183mGPT-6-Luna default\x1b[0m · ~/workspace/projects',
    '  ← for agents · ? for shortcuts',
    '',
  ].join('\n');
}

describe('typedInput for claude', () => {
  it('is empty for a bare prompt', () => {
    expect(typedInput('claude', claude('❯'))).toBe('');
    expect(typedInput('claude', claude('❯   '))).toBe('');
  });

  it('is what user has typed, with the prompt mark stripped', () => {
    expect(typedInput('claude', claude('❯ merge it and'))).toBe('merge it and');
  });

  it('joins a line that wrapped onto the rows below', () => {
    expect(typedInput('claude', claude('❯ first part of a long', '  line that wrapped'))).toBe('first part of a long line that wrapped');
  });

  it('sees through the colours the rules and the box are drawn in', () => {
    const styled = claude('\x1b[2m❯\x1b[0m typed').replaceAll(RULE, `\x1b[38;5;240m${RULE}\x1b[0m`);
    expect(typedInput('claude', styled)).toBe('typed');
  });

  it('takes the last box on the screen, not an earlier rule pair', () => {
    const earlier = [RULE, '❯ old text scrolled away', RULE, ''].join('\n');
    expect(typedInput('claude', `${earlier}\n${claude('❯')}`)).toBe('');
  });

  it('is undefined when the stretch between the rules is not a prompt box', () => {
    // A permission dialog, a /btw overlay, a transcript viewer: something else
    // sits between the last two rules, and there is nothing to wait for.
    expect(typedInput('claude', claude('  Do you want to proceed?', '  ❯ 1. Yes', '    2. No'))).toBeUndefined();
  });

  it('is undefined when no rules frame anything', () => {
    expect(typedInput('claude', '$ ')).toBeUndefined();
    expect(typedInput('claude', '')).toBeUndefined();
    expect(typedInput('claude', `${RULE}\n❯`)).toBeUndefined();
  });
});

describe('typedInput for codex', () => {
  it('reads the dim placeholder as an empty box', () => {
    expect(typedInput('codex', codex(`\x1b[2m${BG}Ask Codex to do anything\x1b[0m`))).toBe('');
    expect(typedInput('codex', codex(''))).toBe('');
  });

  it('is what user has typed, which is not dim', () => {
    expect(typedInput('codex', codex('hello from yan probe'))).toBe('hello from yan probe');
  });

  it('counts a pasted image as unsent input', () => {
    expect(typedInput('codex', codex('\x1b[38;5;6m[Image #1]\x1b[0m'))).toBe('[Image #1]');
  });

  it('joins the indented lines a long entry wrapped onto, and stops at the blank line', () => {
    expect(typedInput('codex', codex('a long entry that', 'wrapped twice', 'over here'))).toBe('a long entry that wrapped twice over here');
  });

  it('is not fooled by 38;2;r;g;b colours that carry a 2 in their parameters', () => {
    expect(typedInput('codex', codex('\x1b[38;2;99;168;248m/model\x1b[0m'))).toBe('/model');
  });

  it('takes the last › line: the ones above are history', () => {
    expect(typedInput('codex', codex(''))).toBe('');
  });

  it('is undefined with no marker on the screen', () => {
    expect(typedInput('codex', '$ ')).toBeUndefined();
    expect(typedInput('codex', '')).toBeUndefined();
  });
});

describe('typedInput for a harness it does not know', () => {
  it('is undefined, so the caller does not wait', () => {
    expect(typedInput('agy', claude('❯ typed'))).toBeUndefined();
    expect(typedInput('', codex('typed'))).toBeUndefined();
  });
});
