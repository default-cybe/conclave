# Conclave for iPhone (Capacitor)

A native iOS wrapper around the Conclave web app. Most people do not need it:
the web app installed from Safari ("Add to Home Screen") does the same job.
Build this when you want a real app icon and app switcher entry.

The app bundles `packages/web/dist` and asks for your hub on first launch. No
hub address is compiled in. iOS only allows HTTPS to remote hosts, so give
the hub an https address first: turn on the quick tunnel in Settings, Remote
access, or run `conclave remote quick` (see `docs/INSTALL.md`, section 2).

## Build and install on your iPhone

You need a Mac with Xcode, Bun, and this repo cloned. A free Apple ID works;
apps signed with it expire after 7 days (rebuild to renew). A paid developer
account lasts a year.

1. Install dependencies from the repo root:

   ```sh
   bun install
   ```

2. Create the Xcode project (once). It lives in `packages/mobile/ios`, which
   is not committed. The script also puts the camera's reason in its
   Info.plist, so Scan QR code can ask for the camera, registers the
   Google sign-in scheme (the shared iOS client id reversed,
   docs/design/OAUTH-APPS.md) so Google can send a sign-in back to the app,
   and runs `bun run assets:ios` (see Light and dark launch below):

   ```sh
   cd packages/mobile
   bun run add:ios
   ```

3. Build the web app and copy it into the Xcode project. Repeat this after
   every web change or `git pull`:

   ```sh
   bun run sync
   ```

4. Open Xcode:

   ```sh
   bun run ios
   ```

5. In Xcode, select the **App** target, open **Signing & Capabilities**, tick
   **Automatically manage signing** and pick your team (your Apple ID).
6. Plug in the iPhone, pick it as the run destination, and press Run.
7. On the phone, the first launch is blocked until you trust the developer:
   **Settings > General > VPN & Device Management**, tap your Apple ID, then
   **Trust**. Turn on **Settings > Privacy & Security > Developer Mode** if
   iOS asks for it.
8. Open Conclave and tap **Scan QR code**, then point the camera at the code
   on the Devices page of the web app (or `conclave pair-phone` on the hub).
   **Use address and password** is the other way in: the hub's address from
   Settings > Remote access (for example `https://conclave.example.com`) and
   its password.

## Light and dark launch

Every frame from the tap to the web app's launch follows the phone's
appearance: the launch image, the web view behind the page, and the page.
`bun run assets:ios` (`scripts/ios-assets.ts`) sets this up in the Xcode
project:

- `Splash.imageset`: the knot on the light ground and on the dark one, picked
  by iOS (`assets/Splash.imageset`).
- `Ground.colorset`: the web app's page ground (`--bg`), `#f9f9fa` light and
  `#0e0e10` dark (`assets/Ground.colorset`). The launch images use the same
  two, so the launch, the web view and the page meet without a step.
- `AppViewController`, a small subclass of Capacitor's view controller in
  `SceneDelegate.swift`: the web view shows the ground until the page paints.
  Capacitor's own `backgroundColor` takes one color only, so it is not set.

**A project made before this** flashes the dark ground on a light phone. Run
this once in `packages/mobile`, then delete Conclave from the phone (iOS keeps
the old launch screen until the app is removed) and press Run in Xcode:

```sh
bun run assets:ios
bun run sync
```

## Notes

- App id: `dev.conclave.app`. Icon: `assets/icon-1024.png`; launch images:
  `assets/Splash.imageset`. `bun run add:ios` copies them in; after a logo
  change run `bun run assets:ios`. They are drawn by
  `bun scripts/brand/knot.ts` from `docs/design/brand/knot.json`, which also
  writes both `Contents.json` files.
- The launch follows the phone's appearance, not the theme picked in
  Settings, Appearance: with Dark picked on a light phone the launch is
  light and the app turns dark when it paints.
- Live reload while developing: run the Vite dev server, then
  `CONCLAVE_DEV_URL=http://<your-mac-ip>:5173 bunx cap run ios`.
