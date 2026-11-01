/**
 * Skills agents wrote with SkillManage (core/extensions/learned.ts), in
 * Extensions > Skills: the Learned word and its session on each row, the
 * Learned filter, and in the detail sheet the owner's controls: edit the
 * text, turn it off or on, delete it. Saving without asking (skills.learn)
 * is set here too.
 */
import { useState } from 'react';
import { Link } from 'wouter';
import type { InventoryItemDto, LearnedSkillDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { folderName } from '@/lib/format';
import { cn } from '@/lib/text';
import { toast, updateConfig, useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Textarea } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { Markdown } from '@/features/chat/Markdown';
import { Block, TOUCH, sentence } from '../shared/parts';

export interface LearnedGroup {
  item: InventoryItemDto;
  shadowed: InventoryItemDto[];
}

function errMsg(e: unknown): string {
  return sentence(e instanceof Error ? e.message : String(e));
}

/**
 * The inventory groups with learned skills marked, plus a row for each
 * learned skill the inventory leaves out (turned off, or for another folder).
 */
export function withLearned<G extends LearnedGroup>(groups: G[], learned: LearnedSkillDto[], make: (item: InventoryItemDto) => G): G[] {
  const byPath = new Map(learned.map((l) => [l.path, l]));
  const seen = new Set<string>();
  const out = groups.map((g) => {
    const hit = (g.item.path && byPath.get(g.item.path)) || (g.item.learned ? learned.find((l) => l.name === g.item.name) : undefined);
    if (!hit) return g;
    seen.add(hit.name);
    return { ...g, item: { ...g.item, learned: true } };
  });
  for (const l of learned) {
    if (seen.has(l.name) || out.some((g) => g.shadowed.some((s) => s.path === l.path))) continue;
    out.push(make({ kind: 'skill', name: l.name, description: l.description, source: 'user', path: l.path, scope: 'learned', active: true, learned: true }));
  }
  return out.sort((a, b) => a.item.name.localeCompare(b.item.name));
}

/** "Learned from Restore drill, 3 days ago" under a row. Off skills say so first. */
export function LearnedLine({ l }: { l: LearnedSkillDto }) {
  return (
    <span className="mt-0.5 block text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
      {!l.enabled && <span className="text-fg-2">Off. </span>}
      From {l.sessionTitle ? <span className="text-fg-2">{l.sessionTitle}</span> : l.sessionId ? 'a session that is gone' : 'an agent'}, {l.created}
      {l.project && <>, for {folderName(l.project)}</>}
    </span>
  );
}

/** skills.learn: ask before an agent saves or changes a skill, or not. */
export function LearnSetting() {
  const config = useHub((s) => s.config);
  const auto = (config?.skills as { learn?: string } | undefined)?.learn === 'auto';
  const [busy, setBusy] = useState(false);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] text-fg-2 phone:basis-full phone:text-[14px]">
        Agents save a method as a skill after a long task or a tricky fix, and patch one that turned out wrong. {auto ? 'They save without asking.' : 'Each save asks you first.'}
      </p>
      <OnOff
        label="Ask before saving skills"
        onLabel="Ask first"
        offLabel="Save without asking"
        size="sm"
        disabled={busy}
        checked={!auto}
        onChange={async (ask) => {
          setBusy(true);
          try {
            await updateConfig({ skills: { learn: ask ? 'ask' : 'auto' } });
          } catch (e) {
            toast({ title: `Could not save. ${errMsg(e)}`, level: 'error' });
          }
          setBusy(false);
        }}
      />
    </div>
  );
}

/** The learned part of the skill sheet: where it came from, its text and the owner's controls. */
export function LearnedBlocks({ l, onChanged, onDeleted }: { l: LearnedSkillDto; onChanged: (next: LearnedSkillDto) => void; onDeleted: () => void }) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(l.description);
  const [body, setBody] = useState(l.body ?? '');
  const [busy, setBusy] = useState<'save' | 'toggle' | null>(null);
  const [deleting, setDeleting] = useState(false);

  const patch = async (what: 'save' | 'toggle', p: { description?: string; body?: string; enabled?: boolean }) => {
    setBusy(what);
    try {
      const next = await api().updateLearnedSkill(l.name, p);
      onChanged(next);
      if (what === 'save') setEditing(false);
      toast({ title: what === 'save' ? 'Skill saved.' : next.enabled ? 'Skill on. Agents see it from their next turn.' : 'Skill off. Agents no longer see it.' });
    } catch (e) {
      toast({ title: `Could not change it. ${errMsg(e)}`, level: 'error' });
    }
    setBusy(null);
  };

  return (
    <>
      <Block title="Learned" className="mt-5">
        <p className="text-[13px] leading-[1.55] text-fg-2 phone:text-[14px]">
          An agent saved this on {l.created}
          {l.sessionId && (
            <>
              {' '}
              in{' '}
              {l.sessionTitle ? (
                <Link href={`/s/${l.sessionId}`} className="link tap">
                  {l.sessionTitle}
                </Link>
              ) : (
                'a session that was deleted'
              )}
            </>
          )}
          . {l.updated !== l.created ? `Changed ${l.updated}. ` : ''}
          {l.lastUsedAt ? `Last loaded ${new Date(l.lastUsedAt).toISOString().slice(0, 10)}, ${l.uses === 1 ? 'once' : `${l.uses} times`} in all.` : 'Not loaded yet.'}
          {l.project ? ` Only for ${l.project}.` : ''}
        </p>
        {!l.enabled && <p className="mt-2 text-[13px] text-fg phone:text-[14px]">Off{l.disabledReason ? `: ${sentence(l.disabledReason)}` : '.'} Agents do not see it.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {!editing && (
            <Button size="sm" className={TOUCH} onClick={() => (setDescription(l.description), setBody(l.body ?? ''), setEditing(true))}>
              Edit
            </Button>
          )}
          <Button size="sm" className={TOUCH} busy={busy === 'toggle' ? (l.enabled ? 'Turning off' : 'Turning on') : false} onClick={() => void patch('toggle', { enabled: !l.enabled })}>
            {l.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          <Button size="sm" variant="quiet-fault" className={TOUCH} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </Block>

      <Block title="SKILL.md">
        {editing ? (
          <div className="space-y-2">
            <Input size="sm" value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" placeholder="What it does and when to use it" />
            <Textarea value={body} minRows={8} maxRows={24} onChange={(e) => setBody(e.target.value)} aria-label="Skill text" className="mono text-[12.5px]" />
            <div className="flex gap-2">
              <Button size="sm" variant="solid" className={TOUCH} disabled={!body.trim() || (description === l.description && body === (l.body ?? ''))} busy={busy === 'save' ? 'Saving' : false} onClick={() => void patch('save', { description, body })}>
                Save
              </Button>
              <Button size="sm" variant="quiet" className={TOUCH} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Markdown text={l.body ?? ''} className={cn('text-[14px]', !l.enabled && 'opacity-70')} />
        )}
      </Block>

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete the skill ${l.name}?`}
        confirm="Delete"
        busy="Deleting"
        onConfirm={async () => {
          try {
            await api().deleteLearnedSkill(l.name);
            toast({ title: `Deleted ${l.name}.` });
            onDeleted();
          } catch (e) {
            toast({ title: `Could not delete it. ${errMsg(e)}`, level: 'error' });
          }
        }}
      >
        <p className="m-0">The folder and its SKILL.md go. To keep it but hide it from agents, turn it off instead.</p>
      </ConfirmDialog>
    </>
  );
}
