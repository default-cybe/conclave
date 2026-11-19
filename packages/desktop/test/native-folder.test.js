/**
 * The native folder picker (src-tauri/src/main.rs pick_folder): checked from the sources, so it runs
 * where cargo does not. The hub page gets two app commands, never a dialog:* or fs:* permission.
 *
 *   bun test packages/desktop/test
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../src-tauri/${p}`, import.meta.url), 'utf8');
const main = read('src/main.rs');
const grant = main.slice(main.indexOf('fn grant_hub_ipc'), main.indexOf('fn hub_page('));

test('the hub page may call native_folder_device and pick_folder, and no dialog or fs permission', () => {
  expect(grant).toContain('.permission("allow-native-folder-device")');
  expect(grant).toContain('.permission("allow-pick-folder")');
  for (const text of [grant, read('capabilities/default.json')]) {
    expect(text).not.toMatch(/"(dialog|fs):/);
  }
  const build = read('build.rs');
  expect(build).toContain('"native_folder_device"');
  expect(build).toContain('"pick_folder"');
  expect(main).toMatch(/generate_handler!\[[\s\S]*native_folder_device,\s*pick_folder\s*\]/);
});

test('only the main or quick window on the current hub origin reaches the folder commands', () => {
  const hubWindow = main.slice(main.indexOf('fn hub_window'), main.indexOf('/// The device id the hub page'));
  expect(hubWindow).toContain('matches!(window.label(), MAIN | QUICK)');
  expect(hubWindow).toContain('on_current_hub(hub_base(window.app_handle()).as_ref(), &u)');
  expect(main).toContain('base.is_some_and(|b| b.origin() == page.origin())');
});

test('native_folder_device answers only a current hub window, before and after the daemon check', () => {
  const device = main.slice(main.indexOf('async fn native_folder_device'), main.indexOf('fn start_dir'));
  expect(device).toMatch(/^async fn native_folder_device\(window: WebviewWindow\) -> Option<String>/);
  expect(device.split('hub_window(&window)').length - 1).toBe(2);
});

test('pick_folder checks hub window, focus and device, rechecks after the lookup and after the dialog', () => {
  const pick = main.slice(main.indexOf('async fn pick_folder'));
  expect(pick).toMatch(/^async fn pick_folder\(window: WebviewWindow, device: String, start: Option<String>\) -> Result<Option<String>, String>/);
  const deviceAt = pick.indexOf('proven.as_deref() != Some(device.as_str())');
  const dialogAt = pick.indexOf('.dialog()');
  expect(deviceAt).toBeGreaterThan(-1);
  for (const check of ['hub_window(window)', 'is_focused()', 'ready(&window)?']) {
    const i = pick.indexOf(check);
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(deviceAt);
  }
  expect(pick.slice(deviceAt, dialogAt)).toContain('ready(&window)?');
  const after = pick.slice(dialogAt);
  expect(after.indexOf('hub_window(&window)')).toBeGreaterThan(-1);
  expect(after.indexOf('hub_window(&window)')).toBeLessThan(after.indexOf('folder_text(picked)'));
});

test('Cargo.lock carries the dialog plugin for cargo --locked', () => {
  const lock = read('Cargo.lock');
  const block = (name) => lock.split('\n\n').find((b) => b.includes(`\nname = "${name}"\n`)) ?? '';
  expect(block('tauri-plugin-dialog')).toContain('version = "2.8.4"');
  expect(block('tauri-plugin-dialog')).toContain('checksum = "ce0fb9c2b6d34a9720627ed930ebc8af26f61e648695aecaeb03d5c33c5896f5"');
  expect(block('tauri-plugin-fs')).toContain('version = "2.7.1"');
  expect(block('rfd')).toContain('version = "0.17.2"');
  expect(block('conclave-desktop')).toContain(' "tauri-plugin-dialog",\n');
  expect(read('Cargo.toml')).toContain('tauri-plugin-dialog = "2.8"');
  // packages sorted by name, as cargo writes them
  const names = [...lock.matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1]);
  expect(names).toEqual([...names].sort());
});
