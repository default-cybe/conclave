/**
 * The Ultra switch in the session composer (docs/WORKFLOWS.md, "Ultra"):
 * a picker in the composer bar next to Permissions. On, the agent plans and
 * runs workflows for real tasks; the line under it says what that costs.
 */
import type { Session } from '@conclave/core/types';
import { SelectMenu } from '@/components/ui/Select';

export const ULTRA_LINE = 'Plans and runs workflows for real tasks. Uses many more tokens.';

export function UltraSwitch({ session, onChange, look = 'text' }: { session: Session; onChange: (on: boolean) => void; look?: 'text' | 'field' }) {
  if (session.kind === 'chat') return null;
  const on = !!session.ultra;
  const menu = (
    <SelectMenu
      look={look}
      label="Ultra"
      prefix={look === 'text' ? 'Ultra' : undefined}
      value={on ? 'on' : 'off'}
      onChange={(v) => onChange(v === 'on')}
      width={300}
      options={[
        { value: 'off', label: 'Off', text: 'Off', detail: 'Workflows only when you ask or the task clearly needs one.' },
        { value: 'on', label: 'On', text: 'On', detail: ULTRA_LINE },
      ]}
    />
  );
  if (look === 'text') return menu;
  return (
    <div>
      {menu}
      {on && <p className="mt-1.5 text-[12px] text-fg-3 phone:text-[13px]">{ULTRA_LINE}</p>}
    </div>
  );
}
