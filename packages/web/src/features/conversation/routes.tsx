/**
 * Route glue for the conversation page (docs/DESIGN.md 15): a chat opened at
 * /s/:id goes to /chat/:id, a session opens on the conversation page, and
 * the old /chats address goes to /sessions (All conversations) with its
 * query kept. On a phone /chats is the list of chats
 * (docs/design/MOBILE-V2.md 6).
 */
import { Redirect, useParams, useSearch } from 'wouter';
import { useHub } from '@/store/store';
import { useIsMobile } from '@/lib/hooks';
import ConversationPage from '@/features/home/ConversationPage';
import { PhoneChats } from '@/features/chat/PhoneChats';
import { isChat } from '@/features/chat/util';

export function SessionRoute() {
  const { id } = useParams<{ id: string }>();
  const chat = useHub((s) => isChat(s.sessions[id]));
  // until the sessions load, a chat opened here would flash the Sessions page before it moves
  const booted = useHub((s) => s.booted || !!s.sessions[id]);
  if (chat) return <Redirect to={`/chat/${id}${window.location.hash}`} replace />;
  if (!booted) return null;
  return <ConversationPage />;
}

export function ChatsRedirect() {
  const search = useSearch();
  const phone = useIsMobile();
  if (phone) return <PhoneChats kind="chats" />;
  return <Redirect to={`/sessions${search ? `?${search}` : ''}`} replace />;
}
