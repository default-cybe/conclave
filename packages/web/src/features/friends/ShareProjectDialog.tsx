/**
 * Share a project with friends (docs/design/FRIENDS.md, "Shared projects as
 * built"): its name, its GitHub repository, the friends to invite, a first
 * note, and whether new sessions in it go to the members. Memories and chats
 * are picked on the project's page, one by one. Opened from Friends (New
 * shared project), from a project's header in the session lists, and from
 * Devices, Folders. A phone gets it as a sheet.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { shareTargets } from '@/lib/shares';
import { projectHref, repoOf, repoOfProject, sharedFrom } from '@/lib/sharedProjects';
import { useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Checkbox, Input, Textarea } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Overlay';
import { createSharedProject } from './projectActions';
import { VerifiedBadge } from './parts';

export interface ShareProjectFrom {
  /** A project of this hub (folders across devices). */
  localProjectId?: string;
  name?: string;
}

export function ShareProjectDialog({ open, onClose, from }: { open: boolean; onClose: () => void; from?: ShareProjectFrom }) {
  const phone = useIsMobile();
  const [, navigate] = useLocation();
  const friendsMap = useHub((s) => s.friends);
  const projects = useHub((s) => s.projects);
  const shared = useHub((s) => s.sharedProjects);
  const targets = useMemo(() => shareTargets(Object.values(friendsMap)), [friendsMap]);
  const local = from?.localProjectId ? projects[from.localProjectId] : undefined;
  const already = from?.localProjectId ? sharedFrom(from.localProjectId, Object.values(shared)) : undefined;
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [shareNew, setShareNew] = useState(false);
  const [busy, setBusy] = useState(false);

  // each time it opens: from the project it was opened on, a lone friend already picked
  useEffect(() => {
    if (!open) return;
    setName(local?.name ?? from?.name ?? '');
    setRepo(repoOfProject(local) ?? '');
    setPicked(targets.length === 1 ? [targets[0].id] : []);
    setNotes('');
    setShareNew(false);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const repoOk = !repo.trim() || !!repoOf(repo);
  const size = phone ? 'touch' : 'md';
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  const submit = async () => {
    if (!name.trim() || !repoOk) return;
    setBusy(true);
    const p = await createSharedProject({
      name: name.trim(),
      ...(repo.trim() ? { repo: repoOf(repo) } : {}),
      ...(from?.localProjectId ? { localProjectId: from.localProjectId } : {}),
      ...(picked.length ? { members: picked } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(shareNew ? { shareNewSessions: true } : {}),
    });
    setBusy(false);
    if (!p) return;
    onClose();
    navigate(projectHref(p.id));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share project"
      description="Friends get an invite in their Inbox. Nothing of it goes before they accept. Code stays on GitHub."
      width={520}
      footer={
        already ? (
          <Button variant="solid" size={size} onClick={() => (onClose(), navigate(projectHref(already.id)))} className="phone:flex-1">
            Open it
          </Button>
        ) : (
          <>
            <Button variant="quiet" size={size} onClick={onClose} className="phone:flex-1">
              Cancel
            </Button>
            <Button variant="solid" size={size} disabled={!name.trim() || !repoOk} busy={busy ? 'Sharing' : false} onClick={() => void submit()} className="phone:flex-1">
              {picked.length ? 'Share and invite' : 'Share'}
            </Button>
          </>
        )
      }
    >
      {already ? (
        <p className="m-0 text-[14px] leading-[1.5] text-fg-2 phone:text-[15px]">
          {already.name} is shared already. {already.line}.
        </p>
      ) : (
        <form
          className="flex flex-col gap-4 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg phone:text-[15px]">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Site" autoFocus={!phone} maxLength={120} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg phone:text-[15px]">GitHub repository</span>
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" mono spellCheck={false} autoCapitalize="off" autoComplete="off" invalid={!repoOk} />
            <span className={cn('text-[12px] leading-[1.45] phone:text-[13px]', repoOk ? 'text-fg-3' : 'text-fault')}>
              {repoOk ? "Optional. Everyone starts sessions from it, and the page shows each member's branches and pull requests." : 'Write it as owner/name, or paste its GitHub address.'}
            </span>
          </label>
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-[13px] font-medium text-fg phone:text-[15px]">Invite</legend>
            {targets.length === 0 ? (
              <p className="m-0 text-[13px] leading-[1.5] text-fg-3 phone:text-[14px]">No friends yet. Share it now and invite them later, or add a friend in Settings, Friends.</p>
            ) : (
              targets.map((f) => (
                <Checkbox
                  key={f.id}
                  checked={picked.includes(f.id)}
                  onChange={(on) => toggle(f.id, on)}
                  label={
                    <span className="flex items-center gap-2">
                      {f.name}
                      {f.verified && <VerifiedBadge />}
                    </span>
                  }
                  className="phone:min-h-11 phone:items-center"
                />
              ))
            )}
          </fieldset>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-fg phone:text-[15px]">Project notes</span>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What it is, how you work on it, who does what." minRows={3} maxRows={8} prose />
            <span className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">Every member gets them. Secrets are taken out before anything leaves your hub.</span>
          </label>
          {(from?.localProjectId || repo.trim()) && (
            <Checkbox
              checked={shareNew}
              onChange={setShareNew}
              label="Share my new sessions in it"
              description="Off by default. Each new session goes to the members after its first turn, as a share they accept."
              className="phone:min-h-11"
            />
          )}
          <p className="m-0 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]">Memories and chats you pick one by one on the project's page. None go by default.</p>
        </form>
      )}
    </Dialog>
  );
}
