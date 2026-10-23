import type { CapacitorConfig } from '@capacitor/cli';

// iOS shell around the Conclave web app. The web build is bundled from
// ../web/dist and asks for the hub URL on first run, so no hub address is
// baked in here. The hub already allows the capacitor:// origin for CORS.
//
// For live reload while developing, point the app at the Vite dev server:
//   CONCLAVE_DEV_URL=http://<your-mac-ip>:5173 bunx cap run ios
const devUrl = process.env.CONCLAVE_DEV_URL;

const config: CapacitorConfig = {
  appId: 'dev.conclave.app',
  appName: 'Conclave',
  webDir: '../web/dist',
  // No backgroundColor: it takes one color, and the launch follows the system
  // appearance. scripts/ios-assets.ts gives the web view the app's ground,
  // light or dark (Ground in the asset catalog); without it iOS uses its own.
  ios: {
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
  },
  ...(devUrl ? { server: { url: devUrl, cleartext: true } } : {}),
};

export default config;
