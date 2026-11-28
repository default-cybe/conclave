/**
 * Reflect as a page (/reflect), next to Memory in the sidebar's More menu:
 * the report, the nightly learnings and the one Nightly reflection switch
 * (ReflectSection). /settings/reflect comes here (settings/nav.ts MOVED).
 */
import { Page, PageHeader, usePageHeader } from '@/components/ui/Page';
import { ReflectSection } from './reflect';

export default function ReflectPage() {
  usePageHeader('Reflect');
  return (
    <Page width="column">
      <PageHeader title="Reflect" sub="Your own report for a week up to a year, and what the assistant learns each night about how you like to work." />
      <ReflectSection />
    </Page>
  );
}
