/**
 * Shared projects (docs/design/FRIENDS.md, "Shared projects as built").
 *
 *   Settings, Friends   the group: invites first, then the projects, and
 *                       New shared project
 *   /projects           the list on its own page (a phone's way in from Friends)
 *   /projects/:id       one project (SharedProjectPage.tsx)
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import { ChevronRight } from 'lucide-react';
import type { SharedProjectDto } from '@conclave/core/client';
import { cn } from '@/lib/text';
import { relTime } from '@/lib/format';
import { useIsMobile, useNow } from '@/lib/hooks';
import { projectHref, projectOrder, projectWords } from '@/lib/sharedProjects';
import { useHub } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Section';
import { Group } from '@/features/settings/parts';
import { ShareProjectDialog } from './ShareProjectDialog';
import { TONE } from './parts';

const SharedProjectPage = lazy(() => import('./SharedProjectPage'));

export default function SharedProjectsRoute() {
  const { id } = useParams<{ id?: string }>();
  if (!id) return <SharedProjectsList />;
  return (
    <Suspense fallback={null}>
      <SharedProjectPage key={id} id={id} />
    </Suspense>
  );
}

/** One project as a row: its name, who is in it and what it holds, how it stands for you. */
export function ProjectRow({ p, now }: { p: SharedProjectDto; now: number }) {
  const w = projectWords(p);
  return (
    <Link href={projectHref(p.id)} className="group flex min-h-[60px] items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <span className="t-row block truncate text-fg underline decoration-transparent underline-offset-[3px] transition-colors duration-[var(--dur-1)] group-hover:decoration-rule-2">{p.name}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-[1.45] text-fg-3 phone:text-[13px]">
          {p.repo ? <span className="font-mono">{p.repo}</span> : null}
          {p.repo ? '. ' : ''}
          {p.line}
        </span>
      </div>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right text-[12px] leading-[1.4] phone:text-[13px]">
        <span className={cn(w.tone === 'dim' ? 'text-fg-3' : TONE[w.tone], w.tone !== 'dim' && 'font-medium')}>{w.word}</span>
        <span className="num text-fg-4">{relTime(p.updatedAt, now)}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-fg-4 transition-colors duration-[var(--dur-1)] group-hover:text-fg-2" strokeWidth={2} aria-hidden />
    </Link>
  );
}

/** In Settings, Friends: the projects, and New shared project. */
export function SharedProjectsGroup() {
  const map = useHub((s) => s.sharedProjects);
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const list = useMemo(() => projectOrder(Object.values(map ?? {})), [map]);
  const shown = list.filter((p) => p.state !== 'declined').slice(0, 8);
  return (
    <Group title="Shared projects" count={list.length || undefined} id="projects" action={{ label: 'New shared project', onClick: () => setOpen(true) }}>
      {shown.length ? (
        shown.map((p) => <ProjectRow key={p.id} p={p} now={now} />)
      ) : (
        <p className="m-0 max-w-[64ch] py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">
          Share a project with friends: its notes, the memories you pick and the chats you choose. Code stays on GitHub, and everyone works from the same repository.
        </p>
      )}
      {list.length > shown.length && (
        <Link href="/projects" className="link block py-3 text-[13px] phone:text-[15px]">
          All shared projects
        </Link>
      )}
      <ShareProjectDialog open={open} onClose={() => setOpen(false)} />
    </Group>
  );
}

function SharedProjectsList() {
  const phone = useIsMobile();
  const map = useHub((s) => s.sharedProjects);
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  usePageHeader('Shared projects', '/settings/friends');
  const list = useMemo(() => projectOrder(Object.values(map ?? {})), [map]);
  const live = list.filter((p) => p.state === 'active' || p.state === 'invited');
  const closed = list.filter((p) => p.state !== 'active' && p.state !== 'invited');
  return (
    <Page width="column">
      {!phone && (
        <div className="pt-6">
          <Link href="/settings/friends" className="link text-[13px]">
            Friends
          </Link>
        </div>
      )}
      <PageHeader
        title="Shared projects"
        className="pt-2"
        sub="Projects you share with friends. Each hub keeps its own copy. Code stays on GitHub."
        actions={
          <Button variant="solid" size={phone ? 'touch' : 'md'} onClick={() => setOpen(true)} className="phone:w-full">
            New shared project
          </Button>
        }
      />
      <Section title="Projects" count={live.length || undefined} rows={false} className="mb-9">
        {live.length ? (
          <div className="rows">
            {live.map((p) => (
              <ProjectRow key={p.id} p={p} now={now} />
            ))}
          </div>
        ) : (
          <p className="m-0 py-3 text-[13px] leading-[1.5] text-fg-3 phone:text-[15px]">None yet. Share a project, or accept an invite from a friend in your Inbox.</p>
        )}
      </Section>
      {closed.length > 0 && (
        <Section title="Read only" count={closed.length} rows={false}>
          <div className="rows">
            {closed.map((p) => (
              <ProjectRow key={p.id} p={p} now={now} />
            ))}
          </div>
        </Section>
      )}
      <ShareProjectDialog open={open} onClose={() => setOpen(false)} />
    </Page>
  );
}
