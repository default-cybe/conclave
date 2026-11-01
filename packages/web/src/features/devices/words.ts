/** Words for devices: what kind of machine it is, and which coding agents it has. */
import type { Device } from '@conclave/core/types';

/** CLI binary names on PATH -> harness ids (logo registry). */
const HARNESS_CLIS: Array<{ cli: string; id: string }> = [
  { cli: 'claude', id: 'claude-code' },
  { cli: 'codex', id: 'codex' },
  { cli: 'opencode', id: 'opencode' },
  { cli: 'gemini', id: 'gemini-cli' },
  { cli: 'cursor-agent', id: 'cursor' },
  { cli: 'cline', id: 'cline' },
  { cli: 'openhands', id: 'openhands' },
];

/** The four agents worth calling out as missing on a machine. */
export const MAIN_HARNESSES = ['claude-code', 'codex', 'opencode', 'gemini-cli'];

export function harnessesOn(d: Device): Array<{ id: string; version: string }> {
  const clis = d.info?.clis ?? {};
  return HARNESS_CLIS.filter((h) => clis[h.cli]).map((h) => ({
    id: h.id,
    version: clis[h.cli],
  }));
}

export function otherTools(d: Device): Array<[string, string]> {
  const skip = new Set(HARNESS_CLIS.map((h) => h.cli));
  return Object.entries(d.info?.clis ?? {}).filter(([k]) => !skip.has(k));
}

const DISTROS: Array<[RegExp, string]> = [
  [/\barch|archbox|endeavour|manjaro/, 'Arch Linux'],
  [/\bkali\b|kali/, 'Kali Linux'],
  [/ubuntu/, 'Ubuntu'],
  [/debian/, 'Debian'],
  [/fedora/, 'Fedora'],
  [/nixos/, 'NixOS'],
  [/alpine/, 'Alpine'],
];

/** "Arch Linux desktop", "macOS laptop", "Proxmox VE host", "Kali Linux VM", "Linux server". The hub says "hub" after its name instead. */
export function deviceKind(d: Device): string {
  const i = d.info;
  const hub = d.id === 'local';
  const names = `${d.name} ${i?.hostname ?? ''}`.toLowerCase();
  let base: string;
  if (!i) base = hub ? 'Hub' : 'Not reported yet';
  else if (i.platform === 'darwin') base = /mbp|macbook|air|laptop/.test(names) ? 'macOS laptop' : 'Mac';
  else if (i.platform === 'ios') base = 'iPhone';
  else if (i.platform === 'android') base = 'Android phone';
  else if (i.platform === 'win32') base = 'Windows';
  else if (i.clis.pvesh || i.clis.qm || i.clis.pct) base = 'Proxmox VE host';
  else {
    const distro = DISTROS.find(([re]) => re.test(names))?.[1] ?? 'Linux';
    const vm = /\bvm\b|-vm|vm-/.test(names);
    const desktop = /desktop|workstation/.test(names) || (i.capabilities.includes('gpu') && i.capabilities.includes('browser'));
    base = vm ? `${distro} VM` : desktop ? `${distro} desktop` : hub ? `${distro} server` : distro;
  }
  return base;
}

/** Capabilities as words: browser, GPU, Docker. */
export function capabilityWords(caps: string[] | undefined): string {
  const map: Record<string, string> = {
    gpu: 'GPU',
    docker: 'Docker',
    browser: 'browser',
    kvm: 'KVM',
  };
  return (caps ?? []).map((c) => map[c] ?? c).join(', ');
}

