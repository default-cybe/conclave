/**
 * Security mode in the composer (docs/design/SECURITY-MODE.md 1.1): the lane
 * chip under the composer once the first message set a lane
 * (session.meta.lane, core security/lanes.ts). Its menu lists the matched
 * lanes first, then the rest, each with its routing line: the model per role
 * from Settings > Security > Roles over the role's profile, or "all roles"
 * under Same model for all work. A pick is saved and logged on the hub.
 */
import type { Session } from '@conclave/core/types';
import { LANES, laneOf, type Lane } from '@conclave/core/security/lanes';
import { api } from '@/lib/api';
import { attempt, upsertSession, useHub } from '@/store/store';
import { modelName } from '@/lib/models';
import { SelectMenu } from '@/components/ui/Select';

/** "hunter Opus 5.5 · validator GLM-5.3" for a lane, from the Roles table and the agents list. */
export function useRouting(session: Session): (lane: Lane) => string {
  const roles = useHub((s) => (s.config as { security?: { roles?: Record<string, { model?: string }> } } | undefined)?.security?.roles);
  const agents = useHub((s) => s.agents);
  return (lane) => {
    if (session.chat?.sameModel) return `all roles: ${modelName(session.model)}`;
    const roster = LANES.find((l) => l.value === lane)?.roles ?? [];
    return roster.map((r) => `${r.replace(/^sec-/, '')} ${modelName(roles?.[r]?.model || agents.find((a) => a.name === r)?.model || session.model)}`).join(' · ');
  };
}

export function LaneChip({ session, look = 'text' }: { session: Session; look?: 'text' | 'field' }) {
  const routing = useRouting(session);
  const cur = laneOf(session.meta);
  if (!session.chat?.security || !cur) return null;
  const order = [...cur.detected, ...LANES.map((l) => l.value).filter((l) => !cur.detected.includes(l))];
  const also = cur.detected.filter((l) => l !== cur.lane).map((l) => LANES.find((x) => x.value === l)!.short);
  const pick = (lane: Lane) => void attempt(async () => upsertSession(await api().updateSession(session.id, { lane })));
  return (
    <SelectMenu
      look={look}
      label="Lane"
      prefix={look === 'text' ? 'Lane' : undefined}
      value={cur.lane}
      onChange={pick}
      width={480}
      className={look === 'text' ? 'h-[24px] shrink-0 text-[12px] phone:h-11 phone:text-[14px]' : undefined}
      options={order.map((l, i) => {
        const def = LANES.find((x) => x.value === l)!;
        const group = i === 0 ? (cur.detected.length ? 'Matched in your message' : 'Lanes') : i === cur.detected.length ? 'Other lanes' : undefined;
        return { value: l, label: def.label, text: `${look === 'text' ? def.short : def.label}${l === cur.lane && also.length ? ` · also ${also.join(', ')}` : ''}`, detail: routing(l), group };
      })}
    />
  );
}
