import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * The strict CSP meta lives in index.html for production builds, but breaks
 * vite dev (react-refresh inline scripts + HMR websocket) — strip it there.
 */
function stripCspInDev(): Plugin {
  return {
    name: 'strip-csp-in-dev',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return ctx.server
          ? html.replace(/<meta[^>]*Content-Security-Policy[^>]*>\s*/i, '')
          : html;
      },
    },
  };
}

export default defineConfig({
  main: {
    // Pi packages are ESM-only; bundle them into the CJS main build instead
    // of externalizing (require() of ESM-only packages would fail).
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'typebox'],
      }),
    ],
    build: {
      rollupOptions: {
        // Multi-input builds lose the preset's external list in practice
        // (the electron npm installer stub gets bundled and crashes at
        // startup), so pin it explicitly.
        external: ['electron', /^electron\/.+/],
        input: {
          index: fileURLToPath(new URL('./src/main/index.ts', import.meta.url)),
          // Background-job worker entry → out/main/jobs/worker.js (CJS),
          // loaded by node:worker_threads via jobs/runner.ts.
          'jobs/worker': fileURLToPath(new URL('./src/main/jobs/worker.ts', import.meta.url)),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
  },
  preload: {
    // Sandboxed preload scripts can only require Electron builtins, so
    // runtime dependencies (TypeBox) must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['@sinclair/typebox'] })],
  },
  renderer: {
    plugins: [react(), stripCspInDev()],
  },
});
