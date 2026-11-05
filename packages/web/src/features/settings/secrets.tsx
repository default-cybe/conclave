/**
 * Settings > Secrets, the owner's only: the named values ${secret:name}
 * reads in MCP servers and other config strings (secrets.json values).
 * Write-only: the list has each name, its first 4 characters and when it
 * was set, never the value (GET /api/secrets). Add, Replace and Delete go
 * through PUT /api/secrets. Names other pages save (web search keys, plugin
 * settings, the GitHub token and the rest) show read-only with where they
 * are set, so nothing here breaks those pages.
 */
import { useState } from 'react';
import { SECRET_NAME, type SecretInfo } from '@conclave/core/config/secret-names';
import { api } from '@/lib/api';
import { attempt, reloadConfig, toast } from '@/store/store';
import { useIsMobile, useLoad, useNow } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { ConfirmDialog, Dialog } from '@/components/ui/Overlay';
import { EmptyState, LoadingRows } from '@/components/ui/EmptyState';
import { agoWords, Group } from './parts';

/** Why a name typed in Add cannot be saved, or undefined. Pure, for the test. */
export function secretNameError(name: string, taken: string[]): string | undefined {
  if (!name) return undefined;
  if (!SECRET_NAME.test(name)) return 'Use 1 to 64 lowercase letters, digits, dots, dashes and underscores.';
  if (taken.includes(name)) return `${name} exists. Use Replace on its row.`;
  return undefined;
}

function Meta({ s, now }: { s: SecretInfo; now: number }) {
  const bits = [s.prefix ? `${s.prefix}…` : null, s.setAt ? `set ${agoWords(s.setAt, now)}` : null].filter(Boolean);
  return <span className="font-mono text-[11.5px] text-fg-3 phone:text-[12.5px]">{bits.join(', ')}</span>;
}

export function SecretsSection() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const list = useLoad(() => api().secrets(), []);
  const now = useNow(60_000);
  const [edit, setEdit] = useState<{ name?: string } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const all = list.data?.values ?? [];
  const own = all.filter((s) => !s.managedBy);
  const managed = all.filter((s) => s.managedBy);
  const changed = () => {
    list.reload();
    // the MCP form's missing-secret note reads the names from the config answer
    void reloadConfig();
  };

  return (
    <div className="space-y-9">
      <Group
        title="Your secrets"
        count={own.length}
        action={{ label: 'Add', onClick: () => setEdit({}) }}
        help={
          <>
            Use one in an MCP server's env, headers, args or URL as <span className="mono">{'${secret:name}'}</span>. The value stays on the hub and is never shown again.
          </>
        }
      >
        <LoadingRows loading={list.loading && !list.data} rows={3} />
        {list.data && own.length === 0 && (
          <EmptyState wave={false} action={{ label: 'Add a secret', onClick: () => setEdit({}) }}>
            No secrets yet. Save a token here once, then point a server at it by name.
          </EmptyState>
        )}
        {own.map((s) => (
          <div key={s.name} className="flex items-center gap-3 py-2.5 phone:py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px] text-fg phone:text-[14.5px]">{s.name}</div>
              <Meta s={s} now={now} />
            </div>
            <Button variant="quiet" size={size} onClick={() => setEdit({ name: s.name })}>
              Replace
            </Button>
            <Button variant="danger" size={size} className="-mr-2" onClick={() => setRemove(s.name)}>
              Delete
            </Button>
          </div>
        ))}
      </Group>

      {managed.length > 0 && (
        <Group title="Set by other pages" count={managed.length} help="The hub saves these for itself. Change them where they are set.">
          {managed.map((s) => (
            <div key={s.name} className="flex items-center gap-3 py-2.5 phone:py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] text-fg-2 phone:text-[14.5px]">{s.name}</div>
                <Meta s={s} now={now} />
              </div>
              <span className="shrink-0 text-[12.5px] text-fg-3 phone:text-[13.5px]">{s.managedBy}</span>
            </div>
          ))}
        </Group>
      )}

      <SecretDialog open={!!edit} name={edit?.name} taken={all.map((s) => s.name)} onClose={() => setEdit(null)} onSaved={changed} />
      <ConfirmDialog
        open={!!remove}
        onClose={() => setRemove(null)}
        title={`Delete ${remove}?`}
        body={
          <>
            Every server that reads <span className="mono">{`\${secret:${remove}}`}</span> gets an empty value from now on.
          </>
        }
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          if (remove && (await attempt(() => api().setSecret('values', remove, null)))) {
            changed();
            toast({ title: `${remove} deleted.` });
          }
        }}
      />
    </div>
  );
}

function SecretDialog({ open, name, taken, onClose, onSaved }: { open: boolean; name?: string; taken: string[]; onClose: () => void; onSaved: () => void }) {
  const mobile = useIsMobile();
  const [n, setN] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const replacing = !!name;
  const slug = replacing ? name! : n.trim();
  const nameErr = replacing ? undefined : secretNameError(slug, taken);
  const ready = !!slug && !nameErr && !!value.trim();

  const close = () => {
    onClose();
    // the value leaves memory with the dialog
    setValue('');
    setN('');
  };
  const submit = async () => {
    setBusy(true);
    const ok = await attempt(() => api().setSecret('values', slug, value.trim()));
    setBusy(false);
    if (!ok) return;
    toast({ title: `${slug} saved.` });
    onSaved();
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={replacing ? `Replace ${name}` : 'Add a secret'}
      description={replacing ? 'The new value takes the place of the old one. Servers that use it get it at their next start.' : undefined}
      footer={
        <>
          <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={close}>
            Cancel
          </Button>
          <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!ready} busy={busy ? 'Saving' : false} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        {!replacing && (
          <Field label="Name" error={nameErr} help={slug ? <>Use it as <span className="mono">{`\${secret:${slug}}`}</span>.</> : 'Lowercase letters, digits, dots, dashes and underscores.'}>
            <Input mono data-autofocus value={n} onChange={(e) => setN(e.target.value)} placeholder="caido-token" autoComplete="off" spellCheck={false} />
          </Field>
        )}
        <Field label="Value" help="Saved on the hub only. It is never shown again.">
          <Input mono type="password" data-autofocus={replacing ? true : undefined} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" spellCheck={false} />
        </Field>
      </form>
    </Dialog>
  );
}
