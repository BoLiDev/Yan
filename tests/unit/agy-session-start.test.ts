import { afterEach, describe, expect, it } from 'vitest';
import { sessionStart } from '../../src/hooks/session-start.js';

/**
 * Agy's `PreInvocation` stand-in for a `SessionStart` hook. What matters here
 * is who it is for: a shift working on the yan repository inherits this
 * repository's hook registrations, and `YAN_SID` — set in a shift's
 * environment and never in the main agent's — is how it tells them apart.
 */

afterEach(() => {
  delete process.env.YAN_SID;
  delete process.env.YAN_TASK;
});

describe('the agy session-start hook', () => {
  it('injects nothing for a shift, without reading its payload', async () => {
    process.env.YAN_SID = 's3';
    process.env.YAN_TASK = 't1';

    const said: string[] = [];
    const noted: string[] = [];
    let readStdin = false;

    const code = await sessionStart({
      note: (line) => noted.push(line),
      say: (line) => said.push(line),
      stdin: () => {
        readStdin = true;
        return Promise.resolve('{"conversationId":"c1"}');
      },
    });

    expect(code).toBe(0);
    // A `PreInvocation` hook that says nothing has broken its contract, so the
    // quiet path is still an object out loud.
    expect(said).toEqual(['{}']);
    expect(noted).toEqual([]);
    expect(readStdin, 'it is out before there is anything to parse').toBe(false);
  });
});
