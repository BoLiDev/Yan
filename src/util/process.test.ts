import { describe, expect, it } from 'vitest';
import { runProcessAsync } from './process.js';

describe('runProcessAsync', () => {
  it('stops a program that says more than asked for, keeping what it said first', async () => {
    const r = await runProcessAsync(process.execPath, ['-e', "process.stdout.write('ab' + 'x'.repeat(4e6))"], { maxStdout: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout).toBe(`ab${'x'.repeat(998)}`);
  });

  it('keeps all of what a program says within the bound, and its code', async () => {
    const r = await runProcessAsync(process.execPath, ['-e', "process.stdout.write('done'); process.exit(3)"], { maxStdout: 4 });
    expect(r).toEqual({ code: 3, stdout: 'done', stderr: '' });
  });
});
