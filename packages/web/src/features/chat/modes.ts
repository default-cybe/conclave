import type { PermissionMode, SessionMode } from '@conclave/core/types';

/** Session modes. Words only; modes carry no icons (spec 8.1). */
export const MODES: Array<{ value: SessionMode; label: string; description: string }> = [
  { value: 'agent', label: 'Agent', description: 'Tools on, works until done' },
  { value: 'chat', label: 'Chat', description: 'No tools, just talk' },
  { value: 'plan', label: 'Plan', description: 'Read only, proposes a plan' },
  { value: 'jury', label: 'Jury', description: 'Several models answer, a judge decides' },
  { value: 'debate', label: 'Debate', description: 'Two models argue, a judge concludes' },
  { value: 'loop', label: 'Loop', description: 'Repeats until a check passes' },
];

/** Permission modes as the composer and settings write them (spec 11.2.3). */
export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string; description: string }> = [
  { value: 'default', label: 'Ask before edits', description: 'Edits and commands wait for your OK' },
  { value: 'acceptEdits', label: 'Accept edits', description: 'File edits run, commands still ask' },
  { value: 'plan', label: 'Plan only', description: 'Nothing that changes state runs' },
  { value: 'bypass', label: 'Bypass', description: 'Everything runs. Use it in sandboxes only.' },
];

export function permissionMeta(mode: PermissionMode) {
  return PERMISSION_MODES.find((p) => p.value === mode) ?? PERMISSION_MODES[0];
}
