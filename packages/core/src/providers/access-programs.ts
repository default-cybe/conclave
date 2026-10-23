/**
 * Cyber access programs on ChatGPT plan models (OpenAI's access program doc,
 * October 2026). A request names one as access_programs: {cyber: <value>}
 * on the Responses wire; CLIProxyAPI forwards the field (tested on 8.0.20).
 *
 * - standard: the normal safeguards.
 * - daybreak_blue: Daybreak Blue, for approved defenders. GPT-6 Sol takes
 *   standard or Blue; GPT-6.1 Sol and GPT-6 Astra take Blue (they reject Red).
 * - daybreak_red: Daybreak Red, only on gpt-5.6-cyber.
 *
 * Omitted, ChatGPT picks a program the account has access to. The answer
 * names the program that served it (an account without approval asks for
 * Blue and is served standard). Daybreak is not a model: the old aliases
 * gpt-daybreak-blue-latest and gpt-daybreak-red-latest retire on
 * 2026-10-28, and a saved ref to one runs on a named model with the program.
 *
 * No node imports: the web app bundles this file.
 */

export const CYBER_PROGRAMS = ['standard', 'daybreak_blue', 'daybreak_red'] as const;
export type CyberProgram = (typeof CYBER_PROGRAMS)[number];

export function isCyberProgram(v: unknown): v is CyberProgram {
  return typeof v === 'string' && (CYBER_PROGRAMS as readonly string[]).includes(v);
}

const LABELS: Record<CyberProgram, string> = { standard: 'Standard', daybreak_blue: 'Daybreak Blue', daybreak_red: 'Daybreak Red' };

export function cyberLabel(p: CyberProgram): string {
  return LABELS[p];
}

/** "neu/gpt-6-sol" -> "gpt-6-sol", lower case. */
const bare = (model: string) => model.slice(model.lastIndexOf('/') + 1).toLowerCase();

/**
 * The programs a ChatGPT plan model takes, as the doc's table has them, or
 * an empty list for a model without the choice (only GPT models on a
 * ChatGPT plan get one; the caller checks the plan).
 */
export function cyberChoices(model: string): CyberProgram[] {
  const id = bare(model);
  if (id === 'gpt-5.6-cyber') return ['daybreak_red'];
  if (id === 'gpt-6-sol' || id === 'gpt-6.1-sol' || id === 'gpt-6-astra') return ['standard', 'daybreak_blue'];
  if (/^gpt-\d/.test(id) && !/image/.test(id)) return ['standard'];
  return [];
}

/** The retiring alias ids and what a saved ref to one runs on now. */
export const RETIRED_ALIASES: Record<string, { model: string; cyber: CyberProgram }> = {
  'gpt-daybreak-blue-latest': { model: 'gpt-5.6-sol', cyber: 'daybreak_blue' },
  'gpt-daybreak-red-latest': { model: 'gpt-5.6-cyber', cyber: 'daybreak_red' },
};

/** The alias entry for an id (account prefix kept off), or undefined. */
export function retiredAlias(model: string): { model: string; cyber: CyberProgram } | undefined {
  return RETIRED_ALIASES[bare(model)];
}

/** One line for an answer served on another program than the one asked for. */
export function servedNotice(asked: CyberProgram, served: string): string {
  const s = isCyberProgram(served) ? cyberLabel(served) : served;
  if (served === 'standard') return `${cyberLabel(asked)} was asked for, but this account was served with standard safeguards. Its ChatGPT plan has no ${cyberLabel(asked)} approval.`;
  return `${cyberLabel(asked)} was asked for; ChatGPT served this with ${s}.`;
}

/**
 * Clear words for ChatGPT's access program errors, or undefined for any
 * other error. `code` is the error's code, `message` its text (some answers
 * carry only a detail line).
 */
export function accessProgramError(code: string | undefined, message: string): string | undefined {
  switch (code) {
    case 'invalid_access_program':
      return `ChatGPT does not know that Cyber access program (${message}). Pick Default, Standard or a Daybreak program in the model's Cyber access.`;
    case 'unsupported_access_program':
      return 'This model does not take the Cyber access program asked for. Switch to a model that does, or set Cyber access to Standard.';
    case 'access_program_not_enabled':
      return "This ChatGPT account is not approved for that Cyber access program. Set Cyber access to Default or Standard, or ask OpenAI for access.";
  }
  if (/cyber access program is not authorized for this model/i.test(message)) return 'This model does not take the Cyber access program asked for. Switch to a model that does, or set Cyber access to Standard.';
  if (code === 'invalid_value' && /access_programs/i.test(message)) return `ChatGPT does not know that Cyber access program (${message}). Pick Default, Standard or a Daybreak program in the model's Cyber access.`;
  return undefined;
}
