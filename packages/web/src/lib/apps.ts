/**
 * Apps signed in to the hub: the Android app, the iPhone web app, browsers,
 * the desktop app's window and the CLI. They pair with a code or a password
 * (POST /api/pair, /api/login) and only talk to the hub; they run no work,
 * so they are never devices. Devices lists the computers that run the
 * device agent, and a line at its foot counts these; Settings, Your account
 * lists them as Signed in (People shows a member's to the owner).
 *
 * Setup's Devices step and the pairing panel still read the phones here, to
 * say a phone paired.
 */
import { useMemo } from 'react';
import type { AppDto } from '@conclave/core/client';
import { useHub } from '@/store/store';
import type { Connection } from './api';

const PHONE_PLATFORMS = ['android', 'ios'];

/** A phone app that still works: the Android app, the iPhone web app, a browser on a phone. */
export function isPhoneApp(a: AppDto): boolean {
  return !a.revoked && PHONE_PLATFORMS.includes(a.platform ?? '');
}

/** The apps still signed in, the ones connected now first, then by when they were last seen. */
export function signedIn(apps: Record<string, AppDto> | AppDto[]): AppDto[] {
  return (Array.isArray(apps) ? apps : Object.values(apps))
    .filter((a) => !a.revoked)
    .sort((a, b) => Number(!!b.online) - Number(!!a.online) || (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt));
}

/** The phones signed in, oldest first, so a newly paired one comes last. */
export function phoneApps(apps: Record<string, AppDto>): AppDto[] {
  return Object.values(apps)
    .filter(isPhoneApp)
    .sort((a, b) => a.createdAt - b.createdAt);
}

const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows', freebsd: 'FreeBSD' };

/** What kind of app it is, in plain words: "Android" (the app, or a browser on the phone), "iPhone", "Browser", "Desktop app", "Terminal on Linux". */
export function appKind(a: Pick<AppDto, 'platform'>): string {
  const p = a.platform ?? '';
  if (p === 'android') return 'Android';
  if (p === 'ios') return 'iPhone';
  if (p === 'web') return 'Browser';
  if (p === 'desktop') return 'Desktop app';
  if (OS[p]) return `Terminal on ${OS[p]}`;
  return 'App';
}

/** "3 phones and browsers signed in", "1 phone or browser signed in". */
export function signedInWords(n: number): string {
  return n === 1 ? '1 phone or browser signed in' : `${n} phones and browsers signed in`;
}

/** This browser's own sign in among the apps, when it signed in with a code or a password. */
export function isThisBrowser(a: Pick<AppDto, 'id'>, conn: Pick<Connection, 'clientId'> | null | undefined): boolean {
  return !!conn?.clientId && conn.clientId === a.id;
}

/** The apps of whoever is signed in. */
export function useSignedIn(): AppDto[] {
  const apps = useHub((s) => s.apps);
  return useMemo(() => signedIn(apps), [apps]);
}
