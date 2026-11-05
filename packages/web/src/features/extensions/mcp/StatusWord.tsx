/** An MCP server's state in a word. Its own file so the chat (ContextPanel, /mcp) can show it without loading all of Extensions. */
import type { McpStatus } from '@conclave/core/client';
import { StateWord } from '@/components/ui/List';
import { LiveStatus } from '@/components/motion';

export function StatusWord({ st }: { st: McpStatus }) {
  if (st.status === 'connecting') return <LiveStatus state="tool" label="Connecting" still />;
  if (st.status !== 'disabled' && st.auth === 'needs-auth') return <StateWord tone="dim">not connected</StateWord>;
  if (st.status === 'failed') return <StateWord tone="fault">failed</StateWord>;
  if (st.status === 'disabled') return <StateWord tone="dim">off</StateWord>;
  return <StateWord tone="ok">connected</StateWord>;
}
