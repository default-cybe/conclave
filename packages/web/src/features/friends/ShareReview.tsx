/**
 * The review before a share goes (docs/design/FRIENDS.md, phase 2): the
 * title and a note; what goes (the range, tool output, attachments,
 * thinking, the code); and what the sanitizer took out, each value found
 * with how often, Show to see it and Keep anyway. The hub answers every
 * change (POST /api/shares/preview), so the counts are what would go.
 */
import { useId, useState } from 'react';
import type { RedactionItem, ShareCodeMode, SharePreview, ToolOutputMode } from '@conclave/core/client';
import { cn } from '@/lib/text';
import { useIsMobile } from '@/lib/hooks';
import { codeWords, goesAs, maskValue, rangeWords, reportSentence, ruleWord, sizeWords, timesWords, toggleKeep, type RangeStop, type ReviewChoices } from '@/lib/shares';
import { Button } from '@/components/ui/Button';
import { Input, OnOff, Segmented, Select, Textarea } from '@/components/ui/Field';

const LABEL = 'm-0 text-[12px] font-medium text-fg-2 phone:text-[14px]';
const HELP = 'm-0 mt-1 text-[12px] leading-[1.5] text-fg-3 phone:text-[13px]';

/** A labelled control in a row: the label at the left, the control at the right (stacked on a phone). */
function Row({ label, children, help }: { label: string; children: React.ReactNode; help?: React.ReactNode }) {
  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <span className={LABEL}>{label}</span>
        {children}
      </div>
      {help && <p className={HELP}>{help}</p>}
    </div>
  );
}

export function ReviewBody({
  kind,
  preview,
  choices,
  onChoices,
  stops,
  title,
  onTitle,
  note,
  onNote,
  checking,
  error,
}: {
  kind: 'chat' | 'session';
  preview?: SharePreview;
  choices: ReviewChoices;
  onChoices: (c: ReviewChoices) => void;
  /** Where the share can stop: after each turn but the last. */
  stops: RangeStop[];
  title: string;
  onTitle: (v: string) => void;
  note: string;
  onNote: (v: string) => void;
  /** The hub is answering a change. */
  checking: boolean;
  /** The review could not be made. */
  error?: string;
}) {
  const phone = useIsMobile();
  const seg = phone ? 'touch' : 'sm';
  const id = useId();
  const set = (patch: Partial<ReviewChoices>) => onChoices({ ...choices, ...patch });
  const code = preview?.code;
  return (
    <div className="flex flex-col gap-6 text-[13px] text-fg phone:text-[15px]">
      <section className="flex flex-col gap-3" aria-label="Title and note">
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Title</span>
          <Input value={title} onChange={(e) => onTitle(e.target.value)} placeholder={preview?.title ?? 'Title'} aria-label="Title" maxLength={200} className="phone:text-[16px]" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>
            Note <span className="font-normal text-fg-3">optional</span>
          </span>
          <Textarea value={note} onChange={(e) => onNote(e.target.value)} minRows={2} maxRows={6} prose placeholder="What you want them to look at" aria-label="Note" maxLength={2000} />
        </label>
      </section>

      <section aria-labelledby={`${id}-goes`}>
        <h3 id={`${id}-goes`} className="m-0 border-b border-rule-2 pb-2 text-[13px] font-semibold text-fg phone:text-[15px]">
          What goes
        </h3>
        <div className="divide-y divide-rule">
          <Row label="Range" help={preview ? rangeWords(preview) : undefined}>
            <Segmented
              label="Range"
              size={seg}
              value={choices.upTo ? 'part' : 'whole'}
              onChange={(v) => set({ upTo: v === 'whole' ? undefined : (stops[stops.length - 1]?.id ?? undefined) })}
              options={[
                { value: 'whole', label: 'Whole' },
                { value: 'part', label: 'Up to a message', disabled: !stops.length },
              ]}
            />
          </Row>
          {choices.upTo && (
            <div className="py-2">
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Stop after the reply to</span>
                <Select value={choices.upTo} onChange={(e) => set({ upTo: e.target.value })} aria-label="Stop after the reply to">
                  {stops.map((s, i) => (
                    <option key={s.id} value={s.id}>
                      {i + 1}. {s.label}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          )}
          <Row label="Tool output" help={choices.toolOutput === 'summary' ? 'The first lines of each result.' : choices.toolOutput === 'none' ? 'A placeholder in place of each result.' : undefined}>
            <Segmented<ToolOutputMode>
              label="Tool output"
              size={seg}
              value={choices.toolOutput}
              onChange={(v) => set({ toolOutput: v })}
              options={[
                { value: 'full', label: 'Full' },
                { value: 'summary', label: 'Summary' },
                { value: 'none', label: 'None' },
              ]}
            />
          </Row>
          <Row label="Attachments">
            <OnOff label="Attachments" size={seg === 'touch' ? 'touch' : 'sm'} checked={choices.attachments} onChange={(v) => set({ attachments: v })} />
          </Row>
          <Row label="Thinking text" help={choices.thinking ? 'Goes without its signatures.' : undefined}>
            <OnOff label="Thinking text" size={seg === 'touch' ? 'touch' : 'sm'} checked={choices.thinking} onChange={(v) => set({ thinking: v })} />
          </Row>
          {kind === 'session' && (
            <div className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <span className={LABEL}>Code</span>
                <Segmented<ShareCodeMode>
                  label="Code"
                  size={seg}
                  value={choices.code}
                  onChange={(v) => set({ code: v })}
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'diff', label: 'Diff' },
                    { value: 'git-bundle', label: 'Git bundle' },
                  ]}
                />
              </div>
              {code && 'error' in code && <p className="m-0 mt-1.5 text-[12px] leading-[1.5] text-fault phone:text-[13px]">{code.error}</p>}
              {code && !('error' in code) && (
                <div className="mt-1.5">
                  <p className="m-0 text-[12px] leading-[1.5] text-fg-2 phone:text-[13px]">
                    {code.files.length ? `${codeWords(code)}.` : 'No changes to send.'} Untracked and credential files never go.
                  </p>
                  {code.files.length > 0 && (
                    <ul className="m-0 mt-1 list-none p-0 font-mono text-[12px] leading-[1.6] text-fg-2 phone:text-[13px]">
                      {code.files.slice(0, 8).map((f) => (
                        <li key={f} className="truncate">
                          {f}
                        </li>
                      ))}
                      {code.files.length > 8 && <li className="font-sans text-fg-3">and {code.files.length - 8} more</li>}
                    </ul>
                  )}
                  {code.excluded.length > 0 && (
                    <ul className="m-0 mt-1 list-none p-0 text-[12px] leading-[1.6] text-fg-3 phone:text-[13px]">
                      {code.excluded.map((e) => (
                        <li key={e.path} className="truncate">
                          Stays home: <span className="font-mono">{e.path}</span> ({e.reason})
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {!code && choices.code === 'diff' && !preview && <p className={HELP}>The session's changes, with paths from the repository.</p>}
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby={`${id}-out`}>
        <h3 id={`${id}-out`} className="m-0 flex items-baseline gap-2 border-b border-rule-2 pb-2 text-[13px] font-semibold text-fg phone:text-[15px]">
          Taken out
          {preview && preview.items.length > 0 && <span className="num font-[450] text-fg-3">{preview.items.length}</span>}
          {checking && <span className="ml-auto text-[12px] font-normal text-fg-3 phone:text-[13px]">Checking</span>}
        </h3>
        {error ? (
          <p className="m-0 pt-2 text-[13px] leading-[1.5] text-fault phone:text-[14px]">{error}</p>
        ) : !preview ? (
          <p className="m-0 pt-2 text-[13px] text-fg-3 phone:text-[14px]">Reading the session</p>
        ) : (
          <>
            <p className="m-0 pt-2 text-[13px] leading-[1.5] text-fg-2 phone:text-[14px]">{reportSentence(preview.report)}</p>
            <p className={HELP}>System reminders, recalled memories and reasoning blobs never go. Each value below goes as shown unless you keep it.</p>
            {preview.items.length > 0 && (
              <ul className="m-0 mt-1 list-none divide-y divide-rule p-0" aria-label="Values taken out">
                {preview.items.map((item) => (
                  <FoundRow key={item.id} item={item} onKeep={() => onChoices(toggleKeep(choices, item.id))} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {preview && preview.warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Before you send">
          {preview.warnings.map((w) => (
            <li key={w} className="text-[12px] leading-[1.5] text-warn phone:text-[13px]">
              {w}
            </li>
          ))}
        </ul>
      )}
      {preview && <p className="m-0 text-[12px] text-fg-3 phone:text-[13px]">{sizeWords(preview.bytes)}. Their hub fetches it only when they accept, for 30 days.</p>}
    </div>
  );
}

/** One value the sanitizer found: the rule, how often, the value (hidden until Show), and Keep anyway. */
function FoundRow({ item, onKeep }: { item: RedactionItem; onKeep: () => void }) {
  const phone = useIsMobile();
  const [shown, setShown] = useState(false);
  const size = phone ? 'touch' : 'sm';
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1 basis-[220px]">
        <p className="m-0 text-[13px] leading-[1.4] phone:text-[15px]">
          <span className="font-medium text-fg">{ruleWord(item.rule)}</span> <span className="text-fg-3">{timesWords(item.count).toLowerCase()}</span>
        </p>
        <p className={cn('m-0 mt-0.5 font-mono text-[12px] leading-[1.5] break-all phone:text-[13px]', shown ? 'text-fg' : 'text-fg-2')} aria-live="polite">
          {shown ? item.original : maskValue(item.original)}
        </p>
        <p className={cn('m-0 mt-0.5 text-[12px] leading-[1.5] phone:text-[13px]', item.kept ? 'text-warn' : 'text-fg-3')}>
          {goesAs(item)}
          {item.kept && item.rule === 'secret' ? '. Their hub takes a secret out again.' : ''}
        </p>
      </div>
      <div className="-mr-2 flex shrink-0 items-center gap-1 phone:mr-0 phone:-ml-4 phone:w-full">
        <Button variant="quiet" size={size} onClick={() => setShown((v) => !v)} aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} the ${ruleWord(item.rule).toLowerCase()}`}>
          {shown ? 'Hide' : 'Show'}
        </Button>
        <Button variant={item.kept ? 'outline' : 'quiet'} size={size} onClick={onKeep} aria-pressed={item.kept}>
          {item.kept ? 'Take out again' : 'Keep anyway'}
        </Button>
      </div>
    </li>
  );
}
