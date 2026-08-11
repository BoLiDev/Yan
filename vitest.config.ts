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
    // parallel processes is fine, but each test owns its own temp directory.
    //
    // ONE FILE AT A TIME, AND IT IS NOT A PERFORMANCE TUNING - it is the
    // workaround for a
    // real defect, so here is the defect. `runYan` and `fxGit` use spawnSync
    // (tests/helpers/fixtures.ts): the worker's event loop is BLOCKED for the
    // whole of every `bash bin/yan …` and every `git`. Vitest's worker-to-main
    // RPC has a 60s deadline, and a blocked worker cannot answer the reply to
    // its own `onTaskUpdate` - so once contention makes one file's spawns slow
    // enough, vitest prints an Unhandled Error and EXITS 1 WITH EVERY TEST
    // PASSING. Measured on this 16-core Windows box, full suite:
    //
    //   unbounded / 8 / 4 workers   652 pass, 2-5 unhandled errors, exit 1
    //   3 workers                   652 pass, exit 0 twice and exit 1 once
    //   one file at a time          652 pass, exit 0, ~5 min
    //
    // So a worker cap does not fix it, it only makes the lie rarer, which is
    // the worst of the three outcomes. Contention is the input, and this is
    // the only setting that removes it rather than reducing it. A suite that
    // exits non-zero at random is worse than a red one: the first thing
    // anyone does is stop believing the exit code.
    //
    // THE REAL FIX IS AN ASYNC `runYan`, which gives the parallelism back and
    // costs `await` at every call site across the integration tier. It is not
    // done inside a config comment. Until it is, this line is load-bearing.
    fileParallelism: false,
    reporters: ['default'],
  },
});
