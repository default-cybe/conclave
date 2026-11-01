/**
 * Routines (spec 11.5): /routines is the list, /routines/new the editor
 * (optionally from a template, ?template=tpl_brief), /routines/:id one
 * routine with its runs and settings.
 */
import { useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import type { RoutineInput } from '@conclave/core/scheduler/types';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Button } from '@/components/ui/Button';
import { LoadingRows } from '@/components/ui/EmptyState';
import { RoutineList } from './RoutineList';
import { RoutineDetail } from './RoutineDetail';
import { BLANK_ROUTINE, RoutineEditor } from './RoutineEditor';
import { TemplatesDialog, useTemplates } from './Templates';
import { SectionIndex } from './form';
import { useIsMobile } from '@/lib/hooks';

const NEW_SECTIONS: Array<[string, string]> = [
  ['what', 'What'],
  ['when', 'When'],
  ['who', 'Who and where'],
  ['after', 'After a run'],
  ['away', 'While you are away'],
];

export default function RoutinesPage() {
  const { id } = useParams<{ id?: string }>();
  if (id === 'new') return <NewRoutine />;
  if (id) return <RoutineDetail id={id} />;
  return <RoutineList />;
}

/** Older callers handed a template over in sessionStorage. */
function legacyTemplate(): RoutineInput | undefined {
  try {
    const raw = sessionStorage.getItem('conclave.routineTemplate');
    if (!raw) return undefined;
    sessionStorage.removeItem('conclave.routineTemplate');
    const { id: _i, description: _d, ...rest } = JSON.parse(raw) as RoutineInput & { id?: string; description?: string };
    return { ...BLANK_ROUTINE, ...rest };
  } catch {
    return undefined;
  }
}

function NewRoutine() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const tplId = new URLSearchParams(search).get('template');
  const templates = useTemplates();
  const [legacy] = useState(legacyTemplate);
  const [picking, setPicking] = useState(false);
  const phone = useIsMobile();
  usePageHeader('New routine', '/routines');

  const tpl = tplId ? templates.data?.find((t) => t.id === tplId) : undefined;
  const waiting = !!tplId && !templates.data && templates.loading;
  let initial: RoutineInput = legacy ?? BLANK_ROUTINE;
  if (tpl) {
    const { id: _i, description: _d, ...rest } = tpl;
    initial = { ...BLANK_ROUTINE, ...rest };
  }

  return (
    <Page>
      <nav aria-label="Breadcrumb" className="pt-6 text-[12px] phone:hidden">
        <Link href="/routines" className="text-fg-3 hover:text-fg">
          Routines
        </Link>
      </nav>
      <PageHeader
        title={<span className="phone:sr-only">{tpl ? `New routine from ${tpl.name}` : 'New routine'}</span>}
        className="pt-1 phone:pt-2 phone:pb-0"
        sub={tpl ? tpl.description : undefined}
        actions={
          <Button variant="quiet" size={phone ? 'touch' : 'md'} onClick={() => setPicking(true)}>
            {tpl ? 'Other templates' : 'Start from a template'}
          </Button>
        }
      />
      <div className="grid grid-cols-[minmax(0,720px)_minmax(0,1fr)] gap-x-12 max-xl:grid-cols-1">
        {waiting ? <LoadingRows loading rows={4} /> : <RoutineEditor key={tpl?.id ?? 'blank'} initial={initial} onCancel={() => navigate('/routines')} />}
        <SectionIndex items={NEW_SECTIONS} />
      </div>
      <TemplatesDialog open={picking} onClose={() => setPicking(false)} />
    </Page>
  );
}
