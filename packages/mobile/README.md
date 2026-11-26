# Conclave for iPhone and iPad (Capacitor)

A native iOS wrapper around the Conclave web app, for iPhone and iPad. An
iPad gets the desktop layout at wide widths and the phone layout in a narrow
Split View or Slide Over window; it runs in every orientation and in Stage
Manager. Most people do not need it: the web app installed from Safari
("Add to Home Screen") does the same job. Build this when you want a real
app icon, the share sheet for saving files, and pasting pictures.

The Xcode project (`ios/`) is committed. Every change to `packages/mobile`
or `packages/web` builds it on a Mac runner (`.github/workflows/ios.yml`):
for an iPad simulator, and unsigned for a device (artifact
`conclave-ios-unsigned`).

The app bundles `packages/web/dist` and asks for your hub on first launch. No
hub address is compiled in. iOS only allows HTTPS to remote hosts, so give
the hub an https address first: turn on the quick tunnel in Settings, Remote
access, or run `conclave remote quick` (see `docs/INSTALL.md`, section 2).

## Build and install on your iPhone or iPad

You need a Mac with Xcode (from the App Store), Bun, and this repo cloned. A
free Apple ID works; apps signed with it expire after 7 days (rebuild to
renew). A paid developer account lasts a year.

1. Install dependencies from the repo root:

   ```sh
   bun install
   ```

2. The Xcode project is in `packages/mobile/ios`. Its Info.plist has the
   camera's reason (Scan QR code), the photo library's (Save Image from the
   share sheet), the Google sign-in scheme (the shared iOS client id
   reversed, docs/design/OAUTH-APPS.md), iPad orientations and
   `UIRequiresFullScreen` false. Its plugins: Filesystem and Share (saving a
   file opens the share sheet), Clipboard (a picture alone on the clipboard,
   which iOS does not paste into a text box: Cmd+V or + > Paste picture).

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
6. Plug in the iPhone or iPad (trust the Mac on it), pick it as the run
   destination, and press Run.
7. On the device, the first launch is blocked until you trust the developer:
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

## Next: push notifications

Not built. They need:

- A paid Apple Developer team (a free Apple ID cannot use push).
- An APNs auth key (.p8, its key id and team id) stored on the hub as a
  secret.
- A hub sender that posts to APNs (HTTP/2, token auth) next to the web push
  it sends now, with the device token the app registers.
- The Push Notifications capability: the `aps-environment` entitlement on
  the App target, and `@capacitor/push-notifications` to get the token.

## Notes

- App id: `dev.conclave.app`. Icon: `assets/icon-1024.png`; launch images:
  `assets/Splash.imageset`. After a logo change run `bun run assets:ios` and
  commit what it changed in `ios/`. The icon is one 1024 universal image;
  Xcode makes the iPhone and iPad sizes from it. They are drawn by
  `bun scripts/brand/knot.ts` from `docs/design/brand/knot.json`, which also
  writes both `Contents.json` files.
- The launch follows the phone's appearance, not the theme picked in
  Settings, Appearance: with Dark picked on a light phone the launch is
  light and the app turns dark when it paints.
- Live reload while developing: run the Vite dev server, then
  `CONCLAVE_DEV_URL=http://<your-mac-ip>:5173 bunx cap run ios`.
