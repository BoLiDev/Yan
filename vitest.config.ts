import { defineConfig } from 'vitest/config';

// The three tiers are the MVP's, kept by name (plan/conventions.md §5):
//   unit/         fast, seams replaced by fakes
//   integration/  real git, real file system, no network, no Herdr
//   e2e/          real Herdr, real forge; skipped loudly when the binary is absent
//
// Only *.test.ts is collected, so the bash suite (tests/**/*.test.sh) and the
// vitest suite live side by side for the whole migration without either
// discovering the other.
export default defineConfig({
  test: {
    include: ['tests/{unit,integration,e2e}/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Git and worktree fixtures are real directories on disk; running files in
    // parallel processes is fine, but each test owns its own temp directory.
    reporters: ['default'],
  },
});
