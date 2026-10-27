/**
 * /design in a Code session: the direction UI changes should take. One pick
 * (the app's design system, a style, or match a reference URL or
 * screenshot), saved in session meta. The agent reads it as a short brief on
 * its next turn, and a designer subagent gets it too (core
 * session/design-brief.ts).
 */
import { useRef, useState } from 'react';
import type { Session } from '@conclave/core/types';
import { DESIGN_DIRECTIONS, DESIGN_IMAGE_MAX_BYTES, readDesign, type DesignDirection, type DesignInput } from '@conclave/core/session/design-directions';
import { api } from '@/lib/api';
import { attempt, upsertSession } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { Input, Radio } from '@/components/ui/Field';
import { TextAction } from '@/components/ui/Section';
import { readPicked } from '@/features/conversation/ComposerParts';

type Pick = DesignDirection | 'none';
type Shot = { name: string; mediaType: string; data?: string };

export function DesignSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const mobile = useIsMobile();
  const now = readDesign(session.meta);
  const [pick, setPick] = useState<Pick>(now?.direction ?? 'none');
  const [url, setUrl] = useState(now?.url ?? '');
  // data is set only for a screenshot picked here; the stored one stays on the hub
  const [shot, setShot] = useState<Shot | undefined>(now?.image);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    const [read] = await readPicked([], [f], DESIGN_IMAGE_MAX_BYTES);
    if (read) setShot({ name: read.name, mediaType: read.mediaType, data: read.data });
  };

  const reference = pick === 'reference';
  const missing = reference && !url.trim() && !shot;
  const save = async () => {
    setBusy(true);
    const design: DesignInput | null =
      pick === 'none'
        ? null
        : {
            direction: pick,
            ...(reference && url.trim() ? { url: url.trim() } : {}),
            // left out keeps the stored screenshot; null drops it
            ...(reference ? (shot?.data ? { image: { name: shot.name, mediaType: shot.mediaType, data: shot.data } } : shot ? {} : { image: null }) : {}),
          };
    const label = DESIGN_DIRECTIONS.find((d) => d.id === pick)?.label;
    const s = await attempt(() => api().updateSession(session.id, { design }), design ? `Design direction: ${label}. The agent reads it on its next turn.` : 'Design direction cleared.');
    setBusy(false);
    if (s) {
      upsertSession(s);
      onClose();
    }
  };

  return (
    <div className="space-y-5">
      <p className="m-0 text-[13px] leading-[1.45] text-fg-2 phone:text-[15px]">How UI changes in this session should look. The agent gets it as a short brief, and so does a designer it hands work to.</p>
      <div role="radiogroup" aria-label="Design direction" className="space-y-1.5">
        <Radio name="design" checked={pick === 'none'} onChange={() => setPick('none')} label="No direction" description="The agent follows the project as it finds it." />
        {DESIGN_DIRECTIONS.map((d) => (
          <Radio key={d.id} name="design" checked={pick === d.id} onChange={() => setPick(d.id)} label={d.label} description={d.detail}>
            {d.id === 'reference' && (
              <div className="space-y-3">
                <label className="block">
                  <span className="block pb-1.5 text-[12px] font-medium text-fg-2 phone:text-[13px]">Page URL</span>
                  <Input type="url" mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} size={mobile ? 'lg' : 'md'} />
                </label>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] phone:text-[14px]">
                  {shot ? (
                    <>
                      <span className="min-w-0 truncate text-fg-2">{shot.name}</span>
                      <TextAction label="Remove" onClick={() => setShot(undefined)} />
                    </>
                  ) : (
                    <TextAction label="Add a screenshot" onClick={() => file.current?.click()} />
                  )}
                  <span className="text-[12px] text-fg-3 phone:text-[13px]">A URL, a screenshot or both. PNG, JPEG, WebP or GIF, 5 MB at most.</span>
                </div>
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    void choose(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </div>
            )}
          </Radio>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="solid" size={mobile ? 'touch' : 'md'} disabled={busy || missing} onClick={() => void save()}>
          Save
        </Button>
        {missing && <span className="text-[12px] text-fg-3 phone:text-[13px]">Add a URL or a screenshot to match.</span>}
      </div>
    </div>
  );
}
