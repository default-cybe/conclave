/**
 * Settings > Security > Roles (docs/design/SECURITY-MODE.md 1.4): one row per
 * sec-* role, with a model and a fallback over the role's own (core
 * security/roles.ts, config security.roles). Empty uses the role's profile.
 * The lane chip's routing line links here. Every change saves at once; the
 * hub checks the patch (rolesProblem). The owner's only: a member's roles run
 * on models of their own account.
 */
import { useHub } from '@/store/store';
import { ModelPicker } from '@/components/pickers/ModelPicker';
import { Button } from '@/components/ui/Button';
import { modelName } from '@/lib/models';
import { Group, save, SettingRow } from './parts';

type Row = { model?: string | null; fallback?: string[] | null };

/** The order Security mode works in: recon first, reporter last. */
const ORDER = ['sec-recon', 'sec-hunter', 'sec-fuzzer', 'sec-validator', 'sec-exploiter', 'sec-refuter', 'sec-chainer', 'sec-reporter', 'sec-patcher'];

export const ROLES_ORDER_LINE = 'First match wins: a model you name, then Same model for all work, then this table, then the role\u2019s own model, then the chat\u2019s model when none of those can run.';

export function SecuritySection() {
  const agents = useHub((s) => s.agents);
  const table = useHub((s) => (s.config as { security?: { roles?: Record<string, Row | null> } } | undefined)?.security?.roles) ?? {};
  const roles = agents.filter((a) => a.group === 'security').sort((a, b) => rank(a.name) - rank(b.name));
  const write = (role: string, row: Row | null) => void save({ security: { roles: { [role]: row } } });
  return (
    <div className="space-y-9">
      <p className="m-0 max-w-[64ch] text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">{ROLES_ORDER_LINE}</p>
      <Group title="Roles" count={roles.length || undefined} help="Empty uses the role's own model and fallback. The fallback runs when the model is out or answered 404 lately.">
        {roles.length === 0 ? (
          <p className="m-0 py-3.5 text-[13px] text-fg-3 phone:text-[14px]">No sec-* roles are installed.</p>
        ) : (
          roles.map((a) => {
            const row = table[a.name] ?? undefined;
            const model = row?.model ?? undefined;
            const fallback = row?.fallback?.[0];
            const own = [a.model, ...(a.fallback ?? [])].filter(Boolean).map((m) => modelName(m!)).join(', then ');
            return (
              <SettingRow key={a.name} top label={a.name.replace(/^sec-/, '')} help={own ? `Its own: ${own}` : undefined}>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <ModelPicker look="field" harnesses={false} label={`${a.name} model`} placeholder={a.model ? `${modelName(a.model)} (its own)` : 'Its own'} value={model} onChange={(m) => write(a.name, { model: m, fallback: row?.fallback ?? [] })} className="w-[200px] phone:w-full" />
                  <ModelPicker look="field" harnesses={false} label={`${a.name} fallback`} placeholder="No fallback" value={fallback} onChange={(m) => write(a.name, { model: model ?? null, fallback: [m] })} className="w-[200px] phone:w-full" />
                  {row && (
                    <Button variant="ghost" size="sm" onClick={() => write(a.name, null)}>
                      Use its own
                    </Button>
                  )}
                </div>
              </SettingRow>
            );
          })
        )}
      </Group>
    </div>
  );
}

const rank = (name: string) => {
  const i = ORDER.indexOf(name);
  return i < 0 ? ORDER.length : i;
};
