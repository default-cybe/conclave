/**
 * Connect an MCP based memory store (Basic Memory, an MCP memory server) to
 * the owner's other CLIs, so Claude Code, Codex, OpenCode and Gemini CLI
 * read and write the same notes. One step per CLI with its command or the
 * snippet for its config file, each with a copy button.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { CliName, McpConnectStepDto, MemoryConnectionInfo } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { SectionHeading, TextAction } from '@/components/ui/Section';
import { LoadingRows } from '@/components/ui/EmptyState';
import { HarnessName } from '@/components/logo';
import { Cmd, errMsg, Panel } from './parts';

export const HARNESS: Record<CliName, string> = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', gemini: 'gemini-cli' };
export const CLI_LABEL: Record<CliName, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI' };

export function ConnectPanel({ conn, onClose }: { conn: MemoryConnectionInfo | null; onClose: () => void }) {
  const mobile = useIsMobile();
  const [steps, setSteps] = useState<McpConnectStepDto[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!conn) return;
    let alive = true;
    setSteps(undefined);
    setError(undefined);
    api()
      .memoryConnectionConnectPlan(conn.id)
      .then((s) => alive && setSteps(s))
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [conn]);

  return (
    <Panel
      open={!!conn}
      onClose={onClose}
      title="Connect to my CLIs"
      sub={conn ? `${conn.name}, so your other tools read and write the same notes` : undefined}
      footer={
        <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="max-w-[60ch] text-[14px] leading-[1.45] text-fg-2 phone:text-[15px]">
        Run each command on the machine where that CLI is installed. It adds the same server at user scope, so every project sees it. To give them Conclave's own memory instead, use{' '}
        <Link href="/memory/share" className="link" onClick={onClose}>
          Share
        </Link>
        .
      </p>
      {error && (
        <p className="mt-5 text-[14px] text-fg-2">
          <span className="text-fault">Failed.</span> {error}
        </p>
      )}
      {!steps && !error && <LoadingRows loading rows={4} className="mt-5" />}
      {steps?.map((s) => (
        <Step key={s.cli} step={s} />
      ))}
    </Panel>
  );
}

/**
 * One CLI: the command with a copy button, the file snippet on request (or
 * at once when there is no command), the quirk. `bare` drops the heading
 * when the CLI is already named above (the Share tab).
 */
export function Step({ step, className, bare }: { step: McpConnectStepDto; className?: string; bare?: boolean }) {
  const [file, setFile] = useState(false);
  // "~/.config/opencode/opencode.json (mcp)": the file, and the key the entry goes under
  const m = /^(.*?)\s*\((.*)\)$/.exec(step.file);
  const fileName = m?.[1] ?? step.file;
  const toggle = step.command && <TextAction label={file ? 'Hide the file' : `Or edit ${fileName}`} onClick={() => setFile((f) => !f)} />;
  return (
    <section className={className ?? 'mt-7'}>
      {!bare && <SectionHeading right={toggle}>{<HarnessName harness={HARNESS[step.cli]} size={14} />}</SectionHeading>}
      <div className={bare ? 'space-y-2.5' : 'space-y-2.5 pt-3'}>
        {step.command ? (
          <Cmd command={step.command} />
        ) : (
          <p className="text-[13px] text-fg-2 phone:text-[14px]">
            {CLI_LABEL[step.cli]} has no command for this. Add it {m ? <>under <span className="mono">{m[2]}</span> in</> : 'to'} <span className="mono">{fileName}</span>:
          </p>
        )}
        {bare && toggle && <div>{toggle}</div>}
        {(file || !step.command) && <CodeBlock code={step.snippet} lang={step.snippet.trimStart().startsWith('{') ? 'json' : 'toml'} title={<span className="mono">{step.file}</span>} />}
        {step.note && <p className="text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">{step.note}</p>}
      </div>
    </section>
  );
}
