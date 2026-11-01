/**
 * The import sheet: past chats from a device or an uploaded export, and the
 * recent imports under it. Opened from Sessions (List options, Import past
 * chats) and Settings, About. A side panel on desktop, full screen on phones.
 */
import { Panel } from '@/features/memory/parts';
import { PastChats } from './PastChats';
import { Batches, NotLearnedLine } from './Batches';
import { closeImportSheet, useImport } from './store';

export function ImportSheet() {
  const sheet = useImport((s) => s.sheet);
  return (
    <Panel open={sheet.open} onClose={closeImportSheet} title="Import past chats" sub="Claude Code, Codex and Gemini CLI chats on your machines, or a claude.ai or ChatGPT export." width={760}>
      {sheet.open && (
        <div className="space-y-9">
          <PastChats device={sheet.device} compact />
          <NotLearnedLine />
          <Batches limit={4} />
        </div>
      )}
    </Panel>
  );
}
