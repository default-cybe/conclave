/**
 * Settings > About > This client: inside the desktop app the App row shows the
 * app's own version (update_status), its update and its last check error;
 * outside it, the web bundle's version as before.
 *
 *   bun test packages/web/test/client-app-version.test.tsx
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClientAppRow, readAppUpdate, type AppUpdate } from '../src/features/settings/app';
import { version as WEB_VERSION } from '../package.json';

const g = globalThis as unknown as { window?: unknown };
const had = 'window' in g;
const before = g.window;
afterEach(() => {
  if (had) g.window = before;
  else delete g.window;
});

/** A desktop app whose invoke answers update_status with `view`, or throws. */
function inTauri(view: AppUpdate | Error) {
  const calls: string[] = [];
  const invoke = async (cmd: string) => {
    calls.push(cmd);
    if (view instanceof Error) throw view;
    return view;
  };
  g.window = { __TAURI__: { core: { invoke } } };
  return calls;
}

const text = (app?: AppUpdate) => renderToStaticMarkup(<ClientAppRow words="Desktop app" app={app} size="sm" onUpdate={() => {}} />).replace(/<[^>]*>/g, '');

describe('This client, App row', () => {
  test('the desktop app shows its own version, not the web bundle one', async () => {
    const calls = inTauri({ current: '0.4.43', installing: false });
    const app = await readAppUpdate();
    expect(calls).toEqual(['update_status']);
    expect(text(app)).toContain('Desktop app, 0.4.43');
    expect(text(app)).not.toContain('Update to');
  });

  test('an update waiting shows Update to X', async () => {
    inTauri({ current: '0.4.42', available: '0.4.43', installing: false });
    expect(text(await readAppUpdate())).toContain('Update to 0.4.43');
  });

  test('a failed check is said in plain words', async () => {
    inTauri({ current: '0.4.43', installing: false, error: 'error sending request' });
    const t = text(await readAppUpdate());
    expect(t).toContain('The app could not check for updates: error sending request');
    expect(t).not.toContain('Update to');
  });

  test('outside the app, or in an app too old to answer, the web version shows', async () => {
    g.window = {};
    expect(await readAppUpdate()).toBeUndefined();
    inTauri(new Error('update_status not allowed'));
    const app = await readAppUpdate();
    expect(app).toBeUndefined();
    expect(text(app)).toContain(`Desktop app, ${WEB_VERSION}`);
  });
});
