import { describe, expect, it } from 'vitest';
import { AGENT_STATUS_VALUES } from '../../src/externals/terminal/index.js';
import { AGENT_STATUS } from '../../src/externals/terminal-events/index.js';

/**
 * Two modules talk to Herdr, and each declares the agent-status union itself.
 *
 * That duplication is deliberate and it is bounded: no module under
 * `src/externals/` may import another (conventions §2), so the event client
 * cannot reach the terminal's generated schema — and the terminal's copy is
 * GENERATED from `herdr api schema --json`, which is where the truth is.
 *
 * plan/INDEX.md §2: "Duplication is allowed; divergence is not." This is the
 * assertion that makes the second half enforceable. A Herdr upgrade that adds a
 * state regenerates `terminal/schema.ts` and fails here until the event
 * client's union is brought along.
 *
 * This test lives in `tests/unit/` and not inside either module because a
 * module's own test is inside the module, and one external importing another —
 * even in a test — is the forbidden edge itself.
 */

describe('the agent-status vocabulary', () => {
  it('is the same closed set in both modules that speak to herdr', () => {
    expect([...AGENT_STATUS].sort()).toEqual([...AGENT_STATUS_VALUES].sort());
  });

  it('is the set supervision.md §3 maps, complete', () => {
    expect([...AGENT_STATUS].sort()).toEqual(['blocked', 'done', 'idle', 'unknown', 'working']);
  });
});
