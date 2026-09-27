import { defineConfig } from 'vitest/config';

// Where a test lives says who it is for:
//
//   src/<module>/*.test.ts   one module's own test, beside the file it tests,
//                            whether or not it needs the internals. It may
//                            import the module's internal files, which a test
//                            in tests/ could only reach by widening the
//                            public surface.
//   tests/integration/       command-level: through bin/yan, or a command's
//                            exported function with its deps injected
//   tests/e2e/               real Herdr, real forge; skipped loudly when absent
//   tests/unit/              rules that belong to no one module: the module
//                            and entry boundaries, the harness bindings, the
//                            instructions, the shell stub
//
// Only *.test.ts is collected. `tsconfig.json` excludes src/**/*.test.ts from
// the build, so colocated tests never reach dist/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/{unit,integration,e2e}/**/*.test.ts'],
    setupFiles: ['tests/helpers/setup-env.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Git and worktree fixtures are real directories on disk; running files in
    // parallel processes is fine, because each test owns its own temp
    // directory.
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
