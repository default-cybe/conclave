/**
 * Models the owner hid hub-wide (models.hidden, Settings > Models > Hidden
 * models): model refs or globs where `*` matches any run of characters
 * ("cliproxy/glm-*"). A hidden model leaves the pickers and no tier,
 * fallback, agent, workflow or task lands on it (engine.isUsable).
 */
import type { ConclaveConfig } from './schema';

function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
}

/** Whether `ref` matches one of the owner's hidden refs or globs. */
export function isHiddenModel(cfg: Pick<ConclaveConfig, 'models'>, ref: string): boolean {
  const list = cfg.models?.hidden;
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((g) => typeof g === 'string' && g.trim() !== '' && globRe(g.trim()).test(ref));
}

/** What a caller says when it meets a hidden model. */
export function hiddenWords(ref: string): string {
  return `Model ${ref} is hidden by models.hidden (Settings > Models > Hidden models). Pick another model, or remove it from that list.`;
}
