/**
 * The iPhone and iPad app (packages/mobile, a WKWebView): saving a file opens
 * the share sheet (lib/saveFile.ts), a picture alone on the clipboard is read
 * through the app's Clipboard plugin (lib/pasteFiles.ts), the keyboard fit
 * runs on an iPad at every width (PhoneFrame useVisibleViewport), and the
 * Xcode project is an iPad app that runs in Split View.
 *
 *   bun test packages/web/test/ipad-app.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { shareApp, shareFile, shareName } from '../src/lib/saveFile';
import { iosClipboard, onPasteKey, pasteApp } from '../src/lib/pasteFiles';
import { iosKeyboard, keyboardCovers } from '../src/components/PhoneFrame';

const repo = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

/** A fake Capacitor bridge: the plugins it has and the calls it got. */
function bridge(plugins: string[], answer: (plugin: string, method: string, o: Record<string, unknown>) => unknown = () => ({})) {
  const calls: Array<[string, string, Record<string, unknown>]> = [];
  return {
    calls,
    Capacitor: {
      isPluginAvailable: (n: string) => plugins.includes(n),
      nativePromise: async (p: string, m: string, o: Record<string, unknown>) => {
        calls.push([p, m, o]);
        const r = answer(p, m, o);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

describe('saving a file in the iOS app', () => {
  test('only with the Share and Filesystem plugins', () => {
    expect(shareApp({})).toBeUndefined();
    expect(shareApp(bridge(['Share']))).toBeUndefined();
    expect(shareApp(bridge(['Share', 'Filesystem']))).toBeDefined();
  });

  test('writes to the cache, then shares that file', async () => {
    const b = bridge(['Share', 'Filesystem'], (p) => (p === 'Filesystem' ? { uri: 'file:///cache/shared/a.png' } : {}));
    await shareFile(shareApp(b)!, 'a.png', new Blob(['hi']));
    expect(b.calls.map(([p, m]) => `${p}.${m}`)).toEqual(['Filesystem.writeFile', 'Share.share']);
    expect(b.calls[0][2]).toMatchObject({ path: 'shared/a.png', data: btoa('hi'), directory: 'CACHE' });
    expect(b.calls[1][2]).toMatchObject({ files: ['file:///cache/shared/a.png'] });
  });

  test('closing the share sheet is no error', async () => {
    const b = bridge(['Share', 'Filesystem'], (p) => (p === 'Share' ? new Error('Share canceled') : { uri: 'file:///x' }));
    await shareFile(shareApp(b)!, 'a.png', new Blob(['hi']));
    expect(b.calls).toHaveLength(2);
  });

  test('a name stays one file in the cache folder', () => {
    expect(shareName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(shareName('..')).toBe('file');
    expect(shareName('report.pdf')).toBe('report.pdf');
  });
});

describe('a picture on the clipboard in the iOS app', () => {
  const png = btoa('PNG');
  test('read through the Clipboard plugin', async () => {
    const b = bridge(['Clipboard'], () => ({ type: 'image/png', value: `data:image/png;base64,${png}` }));
    expect(await iosClipboard(b)!.invoke('paste_files')).toEqual({ image: png, mime: 'image/png' });
    const text = bridge(['Clipboard'], () => ({ type: 'text/plain', value: 'hi' }));
    expect(await iosClipboard(text)!.invoke('paste_files')).toEqual({});
    expect(iosClipboard({})).toBeUndefined();
    // outside the app the paste path stays as it was
    expect(pasteApp('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBeUndefined();
  });

  test('Cmd+V with no paste event after it attaches the picture', async () => {
    const b = bridge(['Clipboard'], () => ({ type: 'image/png', value: `data:image/png;base64,${png}` }));
    const box = new EventTarget();
    const got: File[][] = [];
    onPasteKey({ key: 'v', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, currentTarget: box }, (f) => got.push(f), iosClipboard(b), 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);
    expect(got[0][0].type).toBe('image/png');
  });

  test('Cmd+V that pasted text, or another key, reads nothing', async () => {
    const b = bridge(['Clipboard'], () => ({ type: 'image/png', value: `data:image/png;base64,${png}` }));
    const box = new EventTarget();
    const key = (k: string, meta = true) => ({ key: k, metaKey: meta, ctrlKey: false, shiftKey: false, altKey: false, currentTarget: box });
    onPasteKey(key('v'), () => undefined, iosClipboard(b), 1);
    box.dispatchEvent(new Event('paste'));
    onPasteKey(key('c'), () => undefined, iosClipboard(b), 1);
    onPasteKey(key('v', false), () => undefined, iosClipboard(b), 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(b.calls).toHaveLength(0);
  });
});

describe('the keyboard on an iPad', () => {
  test('iPadOS says Macintosh but has touch; a Mac has none', () => {
    expect(iosKeyboard({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 })).toBe(true);
    expect(iosKeyboard({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 })).toBe(true);
    expect(iosKeyboard({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 0 })).toBe(false);
  });

  test("in the app a hardware keyboard's shortcut bar counts; a pinch zoom never does", () => {
    expect(keyboardCovers(1032, { height: 977, scale: 1 }, true)).toBe(true);
    expect(keyboardCovers(1032, { height: 977, scale: 1 }, false)).toBe(false);
    expect(keyboardCovers(1032, { height: 640, scale: 1 }, false)).toBe(true);
    expect(keyboardCovers(1032, { height: 500, scale: 2 }, true)).toBe(false);
  });
});

describe('the Xcode project', () => {
  const plist = repo('packages/mobile/ios/App/App/Info.plist');
  const pbx = repo('packages/mobile/ios/App/App.xcodeproj/project.pbxproj');
  test('is an iPhone and iPad app', () => {
    expect(pbx.match(/TARGETED_DEVICE_FAMILY = "1,2";/g)?.length).toBe(2);
  });
  test('runs in Split View, Slide Over and Stage Manager, in every iPad orientation', () => {
    expect(plist).toMatch(/<key>UIRequiresFullScreen<\/key>\s*<false\/>/);
    const ipad = /<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1];
    for (const o of ['Portrait', 'PortraitUpsideDown', 'LandscapeLeft', 'LandscapeRight']) expect(ipad).toContain(`UIInterfaceOrientation${o}<`);
  });
  test('asks for the camera and the photo library it saves to', () => {
    expect(plist).toContain('<key>NSCameraUsageDescription</key>');
    expect(plist).toContain('<key>NSPhotoLibraryAddUsageDescription</key>');
  });
});
