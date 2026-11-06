/**
 * Canvas's New (docs/WORKFLOWS.md, Canvas): a blank program opened at once,
 * like ComfyUI's empty canvas. The owner's goes to their Canvas folder on the
 * hub (core canvas/new.ts) with no question; a member has no files on the hub,
 * so their New asks for a folder on a computer of their own, as "New in
 * folder..." does for anyone. New workflow makes an empty workflow of yours.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { DeviceFolderPicker } from '@/features/chat/pickers';
import { api } from '@/lib/api';
import { attempt, memberNow, upsertSession } from '@/store/store';
import { newFolderRefusal, programHref, workflowHref } from './model';

export function useNewFile() {
  const [, navigate] = useLocation();
  const [asking, setAsking] = useState(false);
  const [device, setDevice] = useState<string>();
  const [cwd, setCwd] = useState('');
  const program = async (input?: { device?: string; cwd?: string }, replace = false) => {
    if (!input && memberNow()) return setAsking(true);
    const made = await attempt(() => api().newCanvasProgram(input));
    if (!made) return;
    // the folder's session must be in the store before the page reads the program through it
    const s = await api().getSession(made.sessionId).catch(() => undefined);
    if (s) upsertSession(s);
    setAsking(false);
    navigate(programHref(made.view.name, made.device, made.cwd), { replace });
  };
  const workflow = async () => {
    const d = await attempt(() => api().newWorkflow());
    if (d) navigate(workflowHref(d.id));
  };
  const refused = newFolderRefusal(memberNow(), device);
  const dialog = (
    <Dialog
      open={asking}
      onClose={() => setAsking(false)}
      title="New program in a folder"
      description="flows/untitled-N.flow.ts in the folder you pick, on a computer you paired."
      footer={
        <Button variant="primary" disabled={!device || !cwd.trim() || !!refused} onClick={() => void program({ device, cwd: cwd.trim() })}>
          Create
        </Button>
      }
    >
      <DeviceFolderPicker look="field" device={device} cwd={cwd} onDevice={setDevice} onCwd={setCwd} />
      {refused && (
        <p role="alert" className="m-0 mt-2 text-[13px] text-fault">
          {refused}
        </p>
      )}
    </Dialog>
  );
  return { program, workflow, inFolder: () => setAsking(true), dialog };
}

/** /canvas/new: Canvas with no last file makes a blank program and opens it (a member picks the folder first). */
export function NewStart() {
  const n = useNewFile();
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    void n.program(undefined, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return n.dialog;
}
