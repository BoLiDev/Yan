import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve, setPrompter } from '../../src/cli/shared/resolve.js';
import { CommandError } from '../../src/cli/shared/errors.js';

/**
 * The soft/hard rule. The half that matters is
 * the refusal: an agent, a hook or a script that reached a prompt would hang
 * forever with nobody to answer it, so "there is no TTY" is checked before "a
 * value is missing" and always wins.
 */

const SPEC = [
  { name: 'task', flag: '--task', describe: 'the task id' },
  { name: 'unit', flag: '--unit', describe: 'the unit name' },
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
    await expect(resolve({ task: 't042', unit: 'auth' }, SPEC)).resolves.toEqual({
      task: 't042',
      unit: 'auth',
    });
  });

  it('refuses without a TTY, naming the flags to pass', async () => {
    setTty(false);
    let thrown: unknown;
    try {
      await resolve({ task: undefined, unit: undefined }, SPEC);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandError);
    expect((thrown as CommandError).code).toBe('missing_options');
    expect((thrown as CommandError).exitCode).toBe(2);
    expect((thrown as CommandError).message).toContain('--task');
    expect((thrown as CommandError).message).toContain('--unit');
  });

  it('refuses with a TTY when no prompter is installed', async () => {
    // With no src/ui/ installed there is no soft
    // path at all, and "no prompter" must refuse rather than hang.
    setTty(true);
    await expect(resolve({ task: undefined }, SPEC.slice(0, 1))).rejects.toBeInstanceOf(CommandError);
  });

  it('prompts only for what is missing, and only with a TTY', async () => {
    setTty(true);
    const prompter = vi.fn(async () => ({ unit: 'auth' }));
    setPrompter(prompter);

    await expect(resolve({ task: 't042', unit: undefined }, SPEC)).resolves.toEqual({
      task: 't042',
      unit: 'auth',
    });
    expect(prompter).toHaveBeenCalledTimes(1);
    expect((prompter.mock.calls[0] as unknown[] | undefined)?.[0]).toEqual([SPEC[1]]);
  });

  it('never prompts without a TTY, even when a prompter is installed', async () => {
    setTty(false);
    const prompter = vi.fn(async () => ({ task: 'nope' }));
    setPrompter(prompter);

    await expect(resolve({ task: undefined }, SPEC.slice(0, 1))).rejects.toBeInstanceOf(CommandError);
    expect(prompter).not.toHaveBeenCalled();
  });

  it('refuses when the prompt came back empty', async () => {
    setTty(true);
    setPrompter(async () => ({}));
    await expect(resolve({ task: undefined }, SPEC.slice(0, 1))).rejects.toBeInstanceOf(CommandError);
  });

  it('treats an empty string as missing', async () => {
    setTty(false);
    await expect(resolve({ task: '', unit: 'auth' }, SPEC)).rejects.toBeInstanceOf(CommandError);
  });
});
