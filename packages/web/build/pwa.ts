/**
 * Vite plugin: the web manifest and the service worker with a precache list
 * of the built app shell. The icons are files in public/icons, drawn by
 * scripts/brand/knot.ts from docs/design/brand/knot.json.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { BRAND, hex } from './color.ts';

const SW_TEMPLATE = fileURLToPath(new URL('./sw.js', import.meta.url));
const ICONS = fileURLToPath(new URL('../public/icons', import.meta.url));

export function manifest() {
  return {
    name: 'Conclave',
    short_name: 'Conclave',
    description: 'Models, agents, routines, memory and usage limits from a hub you run.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    background_color: hex(BRAND.ink),
    theme_color: hex(BRAND.ink),
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'New session', short_name: 'New session', url: '/chats?new=1', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Inbox', short_name: 'Inbox', url: '/approvals', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}

export function pwa(): Plugin {
  return {
    name: 'conclave-pwa',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0].replace(/^\//, '');
        if (path === 'manifest.webmanifest') {
          res.setHeader('content-type', 'application/manifest+json');
          res.end(JSON.stringify(manifest(), null, 2));
          return;
        }
        next();
      });
    },
    generateBundle(_opts, bundle) {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest(), null, 2) });
      const shell = new Set<string>(['/', '/index.html', '/offline.html', '/theme.js', '/favicon.svg', '/favicon.ico', '/manifest.webmanifest']);
      for (const name of Object.keys(bundle)) {
        // fonts outside latin subsets are fetched on demand
        if (/\.(js|css)$/.test(name) || /latin-(standard|wght)-normal\.woff2$/.test(name)) shell.add('/' + name);
      }
      for (const name of readdirSync(ICONS)) if (name.endsWith('.png')) shell.add('/icons/' + name);
      const version = Date.now().toString(36);
      const sw = readFileSync(SW_TEMPLATE, 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify([...shell], null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}
