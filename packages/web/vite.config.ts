import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { pwa } from './build/pwa.ts';

const core = fileURLToPath(new URL('../core/src', import.meta.url));
const src = fileURLToPath(new URL('./src', import.meta.url));
const hub = process.env.CONCLAVE_HUB ?? 'http://127.0.0.1:7717';

export default defineConfig({
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
  },
});
