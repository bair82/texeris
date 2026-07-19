import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // Pi packages are ESM-only; bundle them into the CJS main build instead
    // of externalizing (require() of ESM-only packages would fail).
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'typebox'],
      }),
    ],
  },
  preload: {
    // Sandboxed preload scripts can only require Electron builtins, so
    // runtime dependencies (TypeBox) must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['@sinclair/typebox'] })],
  },
  renderer: {
    plugins: [react()],
  },
});
