import { expect } from 'vitest';

/** What a usage error is checked on: a run of `bin/yan`, or a command function's outcome. */
export type Refusal =
  | { readonly code: number; readonly out: string }
  | { readonly code: number; readonly message: string };

/**
 * A usage error, and the one it was meant to be: exit 2 alone is also what
 * Commander returns for an option that no longer exists, so a test that
 * checks only the code passes for the wrong reason.
 */
export function expectUsage(result: Refusal, needle: string): void {
  const said = 'out' in result ? result.out : result.message;
  expect(result.code, said).toBe(2);
  expect(said).toContain(needle);
}
