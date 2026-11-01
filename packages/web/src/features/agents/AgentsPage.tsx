/** Agents (spec 11.6): /agents is the list, /agents/:name the editor, /agents/new?from=name a copy. */
import { useParams } from 'wouter';
import { AgentList } from './AgentList';
import { AgentEditor } from './AgentEditor';
import { OwnerOnly } from '@/components/OwnerOnly';

export default function AgentsPage() {
  const { name } = useParams<{ name?: string }>();
  // agents live in the hub's config and folders: only the owner adds or copies one (docs/design/ACCOUNTS.md 2)
  if (name === 'new')
    return (
      <OwnerOnly title="New agent" line="Only the owner of this hub adds or changes agents. You can start a session with any agent in the list.">
        <AgentEditor name="new" />
      </OwnerOnly>
    );
  if (name) return <AgentEditor name={decodeURIComponent(name)} />;
  return <AgentList />;
}
