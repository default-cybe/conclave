/**
 * Starter routines (spec 11.5 Templates): rows with the name, what it does,
 * the schedule in words and the agent, and "Use" which opens the editor
 * prefilled. The hub decides the set and the order (routineTemplates()).
 */
import { useLocation } from 'wouter';
import { api } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { describeSchedule } from '@/lib/schedule';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';

export type Template = Awaited<ReturnType<ReturnType<typeof api>['routineTemplates']>>[number];

let cache: Template[] | undefined;

/** The hub's templates, loaded once per page load. */
export function useTemplates() {
  return useLoad(async () => (cache ??= await api().routineTemplates()), []);
}

export function TemplateRows({ onUse, className }: { onUse: (id: string) => void; className?: string }) {
  const t = useTemplates();
  if (!t.data) return <LoadingRows loading={t.loading} rows={4} />;
  return (
    <div className={className}>
      <div className="rows">
        {t.data.map((x) => (
          <div key={x.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 py-3 phone:gap-x-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-[13.5px] font-medium text-fg phone:text-[15px]">{x.name}</span>
                <span className="text-[12px] text-fg-3 phone:text-[13px]">
                  {describeSchedule(x.schedule)}
                  {x.agent ? `, ${x.agent}` : ''}
                </span>
              </div>
              <p className="mt-0.5 text-[13px] leading-[1.45] text-fg-2 phone:text-[14px]">{x.description}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onUse(x.id)} aria-label={`Use ${x.name}`}>
              Use
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TemplatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  return (
    <Dialog open={open} onClose={onClose} title="Templates" description="Each one opens in the editor first, so you can change the time, agent and prompt before saving." width={640}>
      <TemplateRows
        className="-mb-2 border-t border-rule"
        onUse={(id) => {
          onClose();
          navigate(`/routines/new?template=${id}`);
        }}
      />
    </Dialog>
  );
}
