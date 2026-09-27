import { expect } from 'vitest';

/**
 * A usage error, and the one it was meant to be: exit 2 alone is also what
 * Commander returns for an option that no longer exists, so a test that
 * checks only the code passes for the wrong reason.
 */
export function expectUsage(result: { readonly code: number; readonly out: string }, needle: string): void {
  expect(result.code, result.out).toBe(2);
  expect(result.out).toContain(needle);
}
