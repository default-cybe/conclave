/**
 * Connect one MCP server to the owner's CLIs: one step per CLI with its
 * command and config file (copyable), its quirk, and "Run on <device>"
 * after a confirm. connectMcp skips CLIs with no command or not installed.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CliName, McpConnectRunResult, McpConnectStepDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { plural } from '@/lib/format';
import { cn } from '@/lib/text';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { SelectMenu } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { CodeBlock } from '@/components/ui/Code';
import { LoadingRows } from '@/components/ui/EmptyState';
import { HarnessName } from '@/components/logo';
import { Drawer } from '../hooks/Drawer';
import { errText } from '@/features/settings/parts';

const HARNESS: Record<CliName, string> = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', gemini: 'gemini-cli' };
const LABEL: Record<CliName, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini CLI' };

export function ConnectDrawer({ server, open, onClose }: { server: string | null; open: boolean; onClose: () => void }) {
  const mobile = useIsMobile();
  const devices = useHub((s) => s.devices);
  const [steps, setSteps] = useState<McpConnectStepDto[]>();
  const [error, setError] = useState<string>();
  const [device, setDevice] = useState('local');
  const [picked, setPicked] = useState<Partial<Record<CliName, boolean>>>({});
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<McpConnectRunResult[] | null>(null);
  const [runError, setRunError] = useState<string>();

  const list = useMemo(() => Object.values(devices).sort((a, b) => Number(b.online) - Number(a.online) || (a.id === 'local' ? -1 : b.id === 'local' ? 1 : a.name.localeCompare(b.name))), [devices]);
  const dev = devices[device];
  const clis = (dev?.info?.clis ?? {}) as Record<string, string>;

  useEffect(() => {
    if (!open || !server) return;
    let alive = true;
    setSteps(undefined);
    setError(undefined);
    setResults(null);
    setRunError(undefined);
    api()
      .mcpConnectPlan(server)
      .then((s) => alive && setSteps(s))
      .catch((e) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
  }, [open, server]);

  // pre-check the CLIs that have a command and are installed on the device
  useEffect(() => {
    if (!steps) return;
    setPicked(Object.fromEntries(steps.map((s) => [s.cli, !!s.command && !!clis[s.cli]])));
    setResults(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, device]);

  const chosen = (steps ?? []).filter((s) => picked[s.cli]).map((s) => s.cli);
  const devName = dev?.name ?? device;

  const run = async () => {
    if (!server) return;
    setRunning(true);
    setRunError(undefined);
    try {
      setResults(await api().connectMcp(server, device, chosen));
    } catch (e) {
      setRunError(errText(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      label={`Connect ${server ?? ''} to my CLIs`}
      title={
        <>
          Connect <span className="font-mono text-[15px]">{server}</span> to my CLIs
        </>
      }
      sub="Each CLI keeps its own MCP list. These steps add this server to them at user scope."
      footer={
        steps && (
          <>
            <Button variant="quiet" size={mobile ? 'touch' : 'md'} onClick={onClose}>
              Close
            </Button>
            <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={!chosen.length || !dev?.online} busy={running ? 'Running' : false} onClick={() => setConfirm(true)}>
              {chosen.length ? `Run on ${devName}` : 'Pick a CLI to run'}
            </Button>
          </>
        )
      }
    >
      {error && (
        <p className="m-0 text-[14px] leading-[1.45] text-fg-2">
          <span className="text-fault">Failed.</span> {error}
        </p>
      )}
      <LoadingRows loading={!steps && !error} rows={4} />
      {steps && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[13px] text-fg-2 phone:text-[14px]">Run on</span>
            <SelectMenu
              look="text"
              label="Device"
              value={device}
              onChange={setDevice}
              width={260}
              className="phone:h-11"
              options={list.map((d) => ({ value: d.id, label: d.name, text: d.name, disabled: !d.online, hint: d.online ? (d.id === 'local' ? 'hub' : undefined) : 'offline' }))}
            />
            {dev && !dev.online && <span className="text-[13px] text-warn">{dev.name} is offline. Pick another device, or copy the commands.</span>}
          </div>
          <ol className="m-0 mt-2 list-none p-0">
            {steps.map((s) => {
              const r = results?.find((x) => x.cli === s.cli);
              const version = clis[s.cli];
              return (
                <li key={s.cli} className="border-t border-rule-2 py-4 first:border-t-0">
                  <div className="flex items-center gap-3">
                    <HarnessName harness={HARNESS[s.cli]} size={16} className="text-[14px] font-medium text-fg phone:text-[15px]" />
                    <span className="min-w-0 truncate text-[12px] text-fg-3 phone:text-[13px]">{version ? `${version} on ${devName}` : `not installed on ${devName}`}</span>
                    {s.command && (
                      <Checkbox
                        className="ml-auto shrink-0 phone:min-h-11 phone:items-center"
                        checked={!!picked[s.cli]}
                        onChange={(v) => setPicked({ ...picked, [s.cli]: v })}
                        label={<span className="text-[12px] phone:text-[13px]">Run</span>}
                      />
                    )}
                  </div>
                  {s.command ? <CodeBlock className="mt-2.5" shell wrap copy code={s.command} /> : <p className="mt-2 mb-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{LABEL[s.cli]} has no command for this. Paste the snippet into its config file.</p>}
                  <CodeBlock className="mt-2.5" title={<span className="font-mono text-[11.5px]">{s.file}</span>} code={s.snippet} lang={s.file.includes('.toml') ? 'toml' : 'json'} maxLines={12} />
                  {s.note && <p className="mt-2 mb-0 text-[12.5px] leading-[1.45] text-fg-2 phone:text-[13.5px]">{s.note}</p>}
                  {r && (
                    <div className="mt-3" aria-live="polite">
                      {r.skipped ? (
                        <p className="m-0 text-[13px] text-fg-3 phone:text-[14px]">Skipped: {r.skipped}.</p>
                      ) : (
                        <>
                          <p className={cn('m-0 text-[13px] phone:text-[14px]', r.exitCode === 0 ? 'text-ok' : 'text-fault')}>
                            {r.exitCode === 0 ? 'Done' : 'Failed'}, exit {r.exitCode ?? 'none'}
                          </p>
                          {r.stdout.trim() && <CodeBlock className="mt-2" title="stdout" code={r.stdout.trim()} wrap maxLines={8} />}
                          {r.stderr.trim() && <CodeBlock className="mt-2" title="stderr" code={r.stderr.trim()} wrap maxLines={8} />}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {runError && (
            <p className="mt-2 mb-0 text-[13px] leading-[1.45] text-fg-2">
              <span className="text-fault">Failed.</span> {runError}
            </p>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Run ${plural(chosen.length, 'command')} on ${devName}?`}
        tone="neutral"
        confirm="Run"
        busy="Running"
        onConfirm={run}
      >
        <p className="m-0">
          This changes the MCP settings of {chosen.map((c) => LABEL[c]).join(' and ')} on {devName}. If {server} is already there, that CLI may say so and leave it as it is.
        </p>
      </ConfirmDialog>
    </Drawer>
  );
}
