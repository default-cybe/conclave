/** Agent and device pickers on SelectMenu. Agents are words; devices carry their state word. */
import type { ReactNode } from 'react';
import { useHub } from '@/store/store';
import { SelectMenu } from '../ui/Select';

export function AgentPicker({ value, onChange, look = 'text', prefix, className, label = 'Agent', includeHidden }: { value: string | undefined; onChange: (name: string) => void; look?: 'text' | 'field'; prefix?: ReactNode; className?: string; label?: string; includeHidden?: boolean }) {
  const agents = useHub((s) => s.agents);
  const list = agents.filter((a) => includeHidden || a.primary !== false);
  return (
    <SelectMenu
      look={look}
      label={label}
      prefix={prefix}
      className={className}
      value={value}
      onChange={onChange}
      width={300}
      options={list.map((a) => ({ value: a.name, label: a.name, text: a.name, detail: a.description }))}
    />
  );
}

export function DevicePicker({ value, onChange, look = 'text', prefix, className, label = 'Device', onlineOnly }: { value: string | undefined; onChange: (id: string) => void; look?: 'text' | 'field'; prefix?: ReactNode; className?: string; label?: string; onlineOnly?: boolean }) {
  const devices = useHub((s) => s.devices);
  const list = Object.values(devices).filter((d) => !onlineOnly || d.online);
  return (
    <SelectMenu
      look={look}
      label={label}
      prefix={prefix}
      className={className}
      value={value}
      onChange={onChange}
      width={260}
      options={list.map((d) => ({
        value: d.id,
        label: d.name,
        text: d.name,
        hint: <span className={d.online ? 'text-ok' : 'text-fg-3'}>{d.online ? 'online' : 'offline'}</span>,
        disabled: !d.online && onlineOnly,
      }))}
    />
  );
}
