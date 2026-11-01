/** Last runs of an event or one handler: time, exit code, duration, outcome, then stdout and stderr. */
import { Link } from 'wouter';
import type { HookHandlerDto, HookRunDto } from '@conclave/core/client';
import type { HookEvent } from '@conclave/core/config/schema';
import { useHub } from '@/store/store';
import { duration, hhmm, shortDate } from '@/lib/format';
import { cn } from '@/lib/text';
import { CodeBlock } from '@/components/ui/Code';
import { Drawer } from './Drawer';
import { handlerText, resultTone, resultWord, withPluginRoot, type Tone } from './model';

const TONE: Record<Tone, string> = { ok: 'text-ok', fault: 'text-fault', warn: 'text-warn', dim: 'text-fg-3', neutral: 'text-fg-2' };

export function RunsDrawer({ open, onClose, event, handler, runs, roots = {} }: { open: boolean; onClose: () => void; event?: HookEvent; handler?: HookHandlerDto; runs: HookRunDto[]; roots?: Record<string, string> }) {
  const sessions = useHub((s) => s.sessions);
  const list = [...runs].reverse();
  const today = new Date().toDateString();
  return (
    <Drawer
      open={open}
      onClose={onClose}
      label={`Last runs of ${event ?? 'hooks'}`}
      title={
        <>
          Last runs, <span className="font-mono text-[15px]">{event}</span>
        </>
      }
      sub={handler ? <span className="block truncate font-mono text-[11.5px]">{withPluginRoot(handlerText(handler), handler.pluginRoot)}</span> : 'Every handler of this event, newest first. The hub keeps the last 10.'}
    >
      {list.length === 0 && <p className="text-[14px] text-fg-2">No runs yet. Runs show up here after a session reaches this event, or after a test.</p>}
      <ol className="rows m-0 list-none p-0">
        {list.map((r, i) => {
          const s = sessions[r.sessionId];
          const when = new Date(r.at).toDateString() === today ? hhmm(r.at) : `${shortDate(r.at)} ${hhmm(r.at)}`;
          return (
            <li key={`${r.at}:${i}`} className="py-3.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] phone:text-[14px]">
                <span className="num font-mono text-[12px] text-fg-3">{when}</span>
                <span className={cn('font-medium', TONE[resultTone(r.result)])}>{resultWord(r.result)}</span>
                {r.exitCode !== undefined && r.exitCode !== null && <span className="text-fg-3">exit {r.exitCode}</span>}
                <span className="num text-fg-3">{r.timedOut ? 'timed out' : duration(r.durationMs)}</span>
                <span className="ml-auto min-w-0 truncate text-[12px] text-fg-3 phone:text-[13px]">
                  {r.sessionId === 'test' ? (
                    'test run'
                  ) : s ? (
                    <Link href={`/s/${s.id}`} className="hover:text-fg">
                      {s.title}
                    </Link>
                  ) : (
                    <span className="mono">{r.sessionId}</span>
                  )}
                </span>
              </div>
              {!handler && (
                <div className="mt-1 truncate font-mono text-[12px] text-fg-2" title={r.label}>
                  {r.type === 'prompt' ? <span className="font-sans text-fg-3">Prompt: </span> : null}
                  {withPluginRoot(r.label, r.plugin ? roots[r.plugin] : undefined)}
                  {r.plugin && <span className="font-sans text-fg-3">, plugin {r.plugin}</span>}
                </div>
              )}
              {(r.contextChars || r.note) && (
                <p className={cn('mt-1 mb-0 text-[12px] leading-[1.4] phone:text-[13px]', r.note ? 'text-warn' : 'text-fg-3')}>
                  {[r.contextChars && `Added ${r.contextChars.toLocaleString('en-US')} chars to the context, about ${Math.round(r.contextChars / 4).toLocaleString('en-US')} tokens.`, r.note].filter(Boolean).join(' ')}
                </p>
              )}
              {r.stderr?.trim() && <CodeBlock className="mt-2" title="stderr" code={r.stderr.replace(/\n$/, '')} copy wrap maxLines={10} />}
              {r.stdout?.trim() && <CodeBlock className="mt-2" title="stdout" code={r.stdout.replace(/\n$/, '')} copy wrap maxLines={10} />}
              {!r.stderr?.trim() && !r.stdout?.trim() && r.type === 'command' && r.result !== 'async' && <p className="mt-1 mb-0 text-[12px] text-fg-3 phone:text-[13px]">No output.</p>}
            </li>
          );
        })}
      </ol>
    </Drawer>
  );
}
