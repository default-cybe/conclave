#!/usr/bin/env bun
/**
 * Puts Conclave's icon, launch image and ground into the Xcode project that
 * `cap add ios` made (ios/ is not committed). `bun run add:ios` runs it once;
 * run it again (`bun run assets:ios`) after a logo change, or once on a
 * project made before the launch followed the system appearance.
 *
 * - The app icon: assets/icon-1024.png.
 * - The launch image: assets/Splash.imageset, a light and a dark image that
 *   iOS picks by the system appearance.
 * - The ground: assets/Ground.colorset, the app's background light and dark.
 * - The web view shows that ground until the page paints, so no frame between
 *   the launch image and the web app is the wrong color. Capacitor's
 *   backgroundColor takes one color only, so the view controller is a small
 *   subclass (AppViewController, added to SceneDelegate.swift).
 *
 * scripts/brand/knot.ts draws the images and writes both Contents.json files
 * from docs/design/brand/knot.json. Safe to run again: it changes nothing a
 * second time.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MOBILE = join(import.meta.dir, '..');
const APP = join(MOBILE, 'ios', 'App', 'App');
const CATALOG = join(APP, 'Assets.xcassets');
const ASSETS = join(MOBILE, 'assets');

if (!existsSync(CATALOG)) {
  console.error(`No Xcode project at ${APP}. Run bun run add:ios first.`);
  process.exit(1);
}

// the icon
cpSync(join(ASSETS, 'icon-1024.png'), join(CATALOG, 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
console.log('icon: AppIcon.appiconset');

// the launch image and the ground, as whole sets (the template's one color splash goes)
for (const set of ['Splash.imageset', 'Ground.colorset']) {
  rmSync(join(CATALOG, set), { recursive: true, force: true });
  cpSync(join(ASSETS, set), join(CATALOG, set), { recursive: true });
  console.log(`asset: ${set}`);
}

// the view controller: the ground behind the web view
const CLASS = 'AppViewController';
const SUBCLASS = `
/// The web view shows the app's ground (Ground in Assets.xcassets, light or
/// dark with the system) until the page paints, so the launch never flashes
/// the other theme. Added by packages/mobile/scripts/ios-assets.ts.
class ${CLASS}: CAPBridgeViewController {
    private let ground = UIColor(named: "Ground") ?? .systemBackground

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.backgroundColor = ground
        webView?.scrollView.backgroundColor = ground
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        view.window?.backgroundColor = ground
    }
}
`;

/** Replace `from` with `to` in a file once; true when the file now has `to`. */
function patch(file: string, from: string, to: string): boolean {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  if (text.includes(to)) return true;
  if (!text.includes(from)) return false;
  writeFileSync(file, text.replace(from, to));
  return true;
}

const scene = join(APP, 'SceneDelegate.swift');
const delegate = existsSync(scene) ? scene : join(APP, 'AppDelegate.swift');
const code = readFileSync(delegate, 'utf8');
if (!code.includes(`class ${CLASS}`)) writeFileSync(delegate, code.replace(/^import Capacitor$/m, 'import Capacitor\nimport WebKit').trimEnd() + '\n' + SUBCLASS);
// Capacitor 8 makes the view controller in SceneDelegate.swift; older projects take it from Main.storyboard
const inCode = patch(scene, 'rootViewController = CAPBridgeViewController()', `rootViewController = ${CLASS}()`);
const inBoard = patch(join(APP, 'Base.lproj', 'Main.storyboard'), 'customClass="CAPBridgeViewController" customModule="Capacitor"', `customClass="${CLASS}" customModule="App" customModuleProvider="target"`);
if (!inCode && !inBoard) {
  console.error(`Did not find where the project makes its CAPBridgeViewController. Use ${CLASS} there (see ${delegate}).`);
  process.exit(1);
}
console.log(`view controller: ${CLASS} in ${delegate.slice(MOBILE.length + 1)}`);
