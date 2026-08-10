import { defineConfig } from 'vitest/config';

// Where a test lives says who it is for:
//
//   src/<module>/*.test.ts   the MODULE's own test. It may import the module's
//                            internal files, which is exactly why it lives
//                            here: a test in tests/ could only reach them by
//                            widening the public surface.
//   tests/integration/       cross-module, driven through the CLI
//   tests/e2e/               real Herdr, real forge; skipped loudly when absent
//   tests/unit/              what is left: shared helpers and cross-cutting rules
//
// Only *.test.ts is collected, so the bash suite (tests/**/*.test.sh) and the
// vitest suite live side by side for the whole migration without either
// discovering the other. `tsconfig.json` excludes src/**/*.test.ts from the
// build, so colocated tests never reach dist/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/{unit,integration,e2e}/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Git and worktree fixtures are real directories on disk; running files in
    // parallel processes is fine, but each test owns its own temp directory.
    reporters: ['default'],
  },
});
