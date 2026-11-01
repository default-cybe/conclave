/**
 * The quiet "Find ... in Discover" link under an Extensions tab's explainer
 * (ECOSYSTEM.md 3.1). It opens Discover filtered to that tab's kind.
 */
import { Link } from 'wouter';
import { cn } from '@/lib/text';
import type { CatalogKind } from '@conclave/core/client';

const FIND: Record<string, { kind: CatalogKind; label: string }> = {
  tools: { kind: 'mcp', label: 'Find MCP servers in Discover' },
  skills: { kind: 'skill', label: 'Find skills in Discover' },
  commands: { kind: 'command', label: 'Find commands in Discover' },
  plugins: { kind: 'plugin', label: 'Find plugins in Discover' },
  mcp: { kind: 'mcp', label: 'Find MCP servers in Discover' },
  hooks: { kind: 'hook', label: 'Add a hook recipe' },
};

export function DiscoverLink({ tab, className }: { tab: string; className?: string }) {
  const f = FIND[tab];
  if (!f) return null;
  return (
    <Link href={`/extensions/discover?kind=${f.kind}`} className={cn('tap link inline-block text-[13px] phone:text-[14px]', className)}>
      {f.label}
    </Link>
  );
}
