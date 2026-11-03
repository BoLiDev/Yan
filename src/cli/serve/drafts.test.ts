import { describe, expect, it } from 'vitest';
import { DraftSync, fingerprint } from './drafts.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the drafts' push", () => {
  it('waits for the writing to stop, then pushes it all at once', async () => {
    const pushes: number[] = [];
    const sync = new DraftSync(async () => {
      pushes.push(Date.now());
      return null;
    }, () => undefined, 60);
    sync.touched();
    await sleep(30);
    sync.touched();
    await sleep(30);
    sync.touched();
    expect(pushes, 'not while it is written').toEqual([]);
    expect(sync.state).toEqual({ pending: true, error: null });
    await sleep(120);
    expect(pushes).toHaveLength(1);
    expect(sync.state).toEqual({ pending: false, error: null });
  });

  it('pushes at once when asked, and what is written while it runs after it', async () => {
    let release = (): void => undefined;
    const pushes: string[] = [];
    const sync = new DraftSync(async () => {
      pushes.push('push');
      if (pushes.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return null;
    }, () => undefined, 10_000);
    sync.touched();
    const first = sync.now();
    await sleep(10);
    sync.touched();
    release();
    await first;
    await sync.now();
    expect(pushes).toEqual(['push', 'push']);
    expect(sync.state.pending).toBe(false);
    sync.stop();
  });

  it('keeps one that failed, says why, and tries it again on a tick', async () => {
    const answers: (string | null)[] = ['origin cannot be reached', null];
    const sync = new DraftSync(async () => answers.shift() ?? null, () => undefined, 10_000);
    sync.touched();
    await sync.now();
    expect(sync.state).toEqual({ pending: true, error: 'origin cannot be reached' });
    sync.retry();
    await sleep(10);
    expect(sync.state).toEqual({ pending: false, error: null });
    expect(answers).toEqual([]);
  });

  it('fingerprints a text as git does a blob of it', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(fingerprint('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});
