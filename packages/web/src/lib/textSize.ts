/**
 * Text size (Settings > Appearance, this device): the text of a
 * conversation (replies, your messages, tool rows, code) at a scale of the
 * default, which is 15px prose on a desktop and 16px on a phone. Set as
 * --text-scale on <html> (store/ui.ts, and public/theme.js before first
 * paint); styles/index.css .log-text applies it, so it changes live and the
 * rest of the app stays as it is. docs/design/CHAT-AND-MOTION.md 6.5.
 */
export type TextSize = 'small' | 'default' | 'large' | 'larger';

/** The choices, smallest first. public/theme.js keeps the same scales. */
export const TEXT_SIZES: ReadonlyArray<{ value: TextSize; label: string; scale: number }> = [
  { value: 'small', label: 'Small', scale: 0.875 },
  { value: 'default', label: 'Default', scale: 1 },
  { value: 'large', label: 'Large', scale: 1.125 },
  { value: 'larger', label: 'Larger', scale: 1.25 },
];

/** A stored value as a size: anything else (none yet, an old or broken value) is the default. */
export function textSizeOf(v: unknown): TextSize {
  return TEXT_SIZES.find((s) => s.value === v)?.value ?? 'default';
}

/** How much a size scales the conversation's text. */
export function textScale(size: TextSize): number {
  return TEXT_SIZES.find((s) => s.value === size)?.scale ?? 1;
}

/** The CSS variable a size sets on <html>. */
export const TEXT_SCALE_VAR = '--text-scale';

/** Write a size to an element's style (<html>): the conversation follows at once, no reload. */
export function applyTextSize(root: { style: Pick<CSSStyleDeclaration, 'setProperty'> }, size: TextSize): void {
  root.style.setProperty(TEXT_SCALE_VAR, String(textScale(size)));
}
