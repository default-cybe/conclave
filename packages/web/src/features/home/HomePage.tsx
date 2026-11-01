/**
 * Home is a new conversation (docs/DESIGN.md 15): the greeting and the box,
 * in the mode the sidebar's switch is on. Chat is the Chat page; Assistant
 * and Code are the conversation page. The sidebar lists the mode's
 * conversations for both. Today's cards (what waits on you, the plan,
 * proposals) sit under the box.
 *
 * The status page Home used to have (running, limits, routines today,
 * devices) went to the pages behind More.
 */
import { useIsMobile } from '@/lib/hooks';
import { ChatPageRoute } from '@/features/conversation/lazy';
import ConversationPage from './ConversationPage';
import { useStartMode } from './start';

export default function HomePage() {
  const mode = useStartMode((s) => s.mode);
  const phone = useIsMobile();
  if (!phone && mode === 'chat') return <ChatPageRoute />;
  return <ConversationPage />;
}
