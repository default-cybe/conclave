import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pwa } from './build/pwa.ts';

const core = fileURLToPath(new URL('../core/src', import.meta.url));
const src = fileURLToPath(new URL('./src', import.meta.url));
const hub = process.env.CONCLAVE_HUB ?? 'http://127.0.0.1:7717';

// the last release tag a build carries (cli/package.json stays 0.1.0 outside CI); '' without git or tags skips the iPhone app's version check
const bundled = (() => {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^v/, '');
  } catch {
    return '';
  }
})();

export default defineConfig({
  define: { __BUNDLED_VERSION__: JSON.stringify(bundled) },
  plugins: [react(), tailwindcss(), pwa()],
  resolve: {
    alias: [
      // core exports TS source; point Vite at the files directly
      { find: /^@conclave\/core\/client$/, replacement: `${core}/client/index.ts` },
      { find: /^@conclave\/core\/(.*)$/, replacement: `${core}/$1` },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: hub, ws: true, changeOrigin: true },
      '/gw': { target: hub, changeOrigin: true },
      '/v1': { target: hub, changeOrigin: true },
    },
  },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    // the meeting overlay is its own small entry (docs/design/MEETING-MODE.md 2.3); the manifest lets a test check its size and imports
    manifest: true,
    rollupOptions: { input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), overlay: fileURLToPath(new URL('./overlay.html', import.meta.url)) } },
  },
});
