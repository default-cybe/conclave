/**
 * Model id normalization, kept free of node imports so the web app can use
 * it (providers/effort.ts). catalog.ts re-exports it.
 */

/**
 * Canonical lowercase form of a model id: drops vendor prefixes
 * ("anthropic/", "models/", Bedrock "us.anthropic."), snapshot dates,
 * "-latest", OpenRouter variants (":free") and "[1m]" style suffixes.
 */
export function normalizeModelId(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.replace(/^models\//, '');
  if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '');
  s = s.replace(/\[[^\]]*\]$/, '');
  s = s.replace(/:(free|beta|thinking|extended|nitro|floor|online|exacto)$/, '');
  s = s.replace(/-v\d+(?::\d+)?$/, '');
  s = s.replace(/@\d{8}$/, '');
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  s = s.replace(/-latest$/, '');
  // OpenRouter writes Claude versions with dots: claude-sonnet-4.5
  if (s.startsWith('claude-')) s = s.replace(/\./g, '-');
  return s;
}
