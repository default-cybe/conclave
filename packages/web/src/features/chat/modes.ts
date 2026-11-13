import type { PermissionMode, SessionMode } from '@conclave/core/types';

/**
 * Session modes, shown as the composer's "Style" (design review #4). Words
 * only; modes carry no icons (spec 8.1). `more`: an expert style, folded
 * under "More styles" with Ultra.
 */
export const MODES: Array<{ value: SessionMode; label: string; description: string; more?: boolean }> = [
  { value: 'agent', label: 'Agent', description: 'Tools on, works until done' },
  { value: 'chat', label: 'Chat', description: 'No tools, just talk' },
  { value: 'plan', label: 'Plan', description: 'Read only, proposes a plan' },
  { value: 'jury', label: 'Jury', description: 'Several models answer, a judge decides', more: true },
  { value: 'debate', label: 'Debate', description: 'Two models argue, a judge concludes', more: true },
  { value: 'loop', label: 'Loop', description: 'Repeats until a check passes', more: true },
];

/** The heading over the styles, and the fold that holds Jury, Debate, Loop and Ultra. */
export const STYLE_HEADING = 'Working style';
export const MORE_STYLES = 'More styles';

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
