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
// Only *.test.ts is collected. That pattern was how the bash suite and the
// vitest suite lived side by side for the migration without either discovering
// the other; the bash suite went in Phase 9 and the pattern stays because it is
// the right one anyway. `tsconfig.json` excludes src/**/*.test.ts from the
// build, so colocated tests never reach dist/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/{unit,integration,e2e}/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Git and worktree fixtures are real directories on disk; running files in
    // parallel processes is fine, because each test owns its own temp directory
    // (plan/conventions.md §5).
    //
    // This carried `fileParallelism: false` for a while, and the reason it does
    // not any more is worth one line rather than a section: `runYan` and
    // `fxGit` used `spawnSync`, so a worker's event loop was blocked, it missed
    // vitest's 60 s RPC deadline under contention, and the run EXITED 1 WITH
    // EVERY TEST PASSING. Both are async now, and `tests/helpers/fixtures.ts`
    // carries the measurements — including the one that says why making only
    // `runYan` async was not enough.
    reporters: ['default'],
  },
});
