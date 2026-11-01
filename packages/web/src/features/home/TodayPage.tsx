/**
 * Today as its own page (/today): the day plan, today's calendar and the
 * proposals waiting, for phones, where Home is a new chat
 * (docs/design/MOBILE-V2.md 3) and links here with one quiet line.
 */
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { useIsMobile } from '@/lib/hooks';
import { TodaySection } from './today';

export default function TodayPage() {
  const phone = useIsMobile();
  usePageHeader(phone ? 'Today' : undefined, phone ? '/' : undefined);
  return (
    <Page width="column">
      {!phone && <PageHeader title="Today" sub="Your plan, your calendar and what waits for your approval." />}
      <TodaySection phone={phone} title={phone ? 'Your day' : 'Today'} />
    </Page>
  );
}
