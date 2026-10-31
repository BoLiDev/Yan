import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Where a test lives says who it is for:
//
//   src/<module>/*.test.ts   one module's own test, beside the file it tests.
//                            It may import the module's internal files, which
//                            a test elsewhere could only reach by widening the
//                            public surface.
//   web/src/**/*.test.ts     the page's logic that runs without a browser: its
//                            routes, its marks, its diffs, its state
//   web/src/**/*.test.tsx    the page's parts as a person uses them, drawn by
//                            React in Chromium, serve stood in for at fetch
//   tests/integration/       command-level: through bin/yan, or a command's
//                            exported function with its deps injected
//   tests/e2e/               the page in Chromium against a real `yan serve`
//                            on a fixture vault
//
// `tsconfig.json` excludes src/**/*.test.ts from the build, so colocated tests
// never reach dist/. The integration and e2e tests run bin/yan against dist/,
// so `npm test` builds first.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'web/src/**/*.test.ts', 'tests/{integration,e2e}/**/*.test.ts'],
          setupFiles: ['tests/helpers/setup-env.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Each test owns its own temp directories, so files run in parallel. What they spawn is awaited rather than
          // run with spawnSync: a worker whose loop is blocked misses vitest's RPC deadline under load, and the run
          // fails with every test passing.
        },
      },
      {
        plugins: [react()],
        // Found up front, so a dependency first met mid-run does not make Vite reload the tests.
        optimizeDeps: {
          include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-dev-runtime', '@tanstack/react-query', 'zustand', 'dompurify', 'marked', 'highlight.js/lib/core', '@xterm/xterm', 'vitest-browser-react'],
        },
        test: {
          name: 'browser',
          include: ['web/src/**/*.test.tsx'],
          testTimeout: 20_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
