import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { createLogger, defineConfig, type Logger, type ProxyOptions } from 'vite';

/**
 * The page `yan serve` serves, built into dist/web/ beside the CLI's own
 * build, which the server reads it from; everything it needs is in the
 * bundle, so it fetches nothing from the network.
 *
 * `npm run dev:web` runs it with hot reload against a `yan serve` already
 * running, on $YAN_SERVE or the default port: the API, the blobs and the
 * fonts go through to it, and the vault's files come from its files origin,
 * which the index names.
 */
const serve = process.env.YAN_SERVE ?? 'http://localhost:4747';

/**
 * Quiet when it builds, as part of `npm run build`, and as usual when it
 * serves. The fonts app.css names are served by yan serve from
 * templates/fonts/, not built in, so Vite saying it could not find them is no
 * news either way.
 */
function quietAbout(level: 'warn' | 'info'): Logger {
  const logger = createLogger(level);
  for (const kind of ['warn', 'warnOnce'] as const) {
    const say = logger[kind];
    logger[kind] = (msg, options) => {
      if (!msg.includes('/fonts/') || !msg.includes("didn't resolve at build time")) say(msg, options);
    };
  }
  return logger;
}

export default defineConfig(({ command }) => {
  const level = command === 'build' ? 'warn' : 'info';
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    logLevel: level,
    customLogger: quietAbout(level),
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      // React, highlight.js and marked in one file: some 550 kB, read from this machine, so it is not split further.
      chunkSizeWarningLimit: 800,
    },
    server: {
      proxy: Object.fromEntries(['/api', '/blob', '/fonts'].map((path): [string, ProxyOptions] => [path, {
        target: serve,
        changeOrigin: true,
        // yan serve takes writes only from its own page; the dev server stands in for it.
        configure: (proxy) => proxy.on('proxyReq', (req) => {
          if (req.getHeader('origin')) req.setHeader('origin', serve);
        }),
      }])),
    },
  };
});
