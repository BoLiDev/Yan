import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve, setPrompter } from '../../src/cli/shared/resolve.js';
import { YanError } from '../../src/util/error.js';

/**
 * How a missing option is filled in. The half that matters is the refusal:
 * "there is no tty" is checked before "a value is missing" and always wins.
 */

const SPEC = [
  { name: 'name', flag: '--name', describe: 'the vault name' },
  { name: 'remote', flag: '--remote', describe: 'the remote URL' },
];

afterEach(() => {
  setPrompter(undefined);
  vi.unstubAllGlobals();
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
});

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

describe('resolve', () => {
  it('runs straight through when every value is present', async () => {
    setTty(false);
    await expect(resolve({ name: 'personal', remote: 'git@example.invalid:v.git' }, SPEC)).resolves.toEqual({
      name: 'personal',
      remote: 'git@example.invalid:v.git',
    });
  });

  it('refuses without a TTY, naming the flags to pass', async () => {
    setTty(false);
    let thrown: unknown;
    try {
      await resolve({ name: undefined, remote: undefined }, SPEC);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(YanError);
    expect((thrown as YanError).code).toBe('missing_options');
    expect((thrown as YanError).exitCode).toBe(2);
    expect((thrown as YanError).message).toContain('--name');
    expect((thrown as YanError).message).toContain('--remote');
  });

  it('refuses with a TTY when no prompter is installed', async () => {
    // With no prompter installed there is no soft path at all.
    setTty(true);
    await expect(resolve({ name: undefined }, SPEC.slice(0, 1))).rejects.toBeInstanceOf(YanError);
  });

  it('prompts only for what is missing, and only with a TTY', async () => {
    setTty(true);
    const prompter = vi.fn(async () => ({ remote: 'git@example.invalid:v.git' }));
    setPrompter(prompter);

    await expect(resolve({ name: 'personal', remote: undefined }, SPEC)).resolves.toEqual({
      name: 'personal',
      remote: 'git@example.invalid:v.git',
    });
    expect(prompter).toHaveBeenCalledTimes(1);
    expect((prompter.mock.calls[0] as unknown[] | undefined)?.[0]).toEqual([SPEC[1]]);
  });

  it('never prompts without a TTY, even when a prompter is installed', async () => {
    setTty(false);
    const prompter = vi.fn(async () => ({ name: 'nope' }));
    setPrompter(prompter);

    await expect(resolve({ name: undefined }, SPEC.slice(0, 1))).rejects.toBeInstanceOf(YanError);
    expect(prompter).not.toHaveBeenCalled();
  });

  it('refuses when the prompt came back empty', async () => {
    setTty(true);
    setPrompter(async () => ({}));
    await expect(resolve({ name: undefined }, SPEC.slice(0, 1))).rejects.toBeInstanceOf(YanError);
  });

  it('treats an empty string as missing', async () => {
    setTty(false);
    await expect(resolve({ name: '', remote: 'git@example.invalid:v.git' }, SPEC)).rejects.toBeInstanceOf(YanError);
  });
});
