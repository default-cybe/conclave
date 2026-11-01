/**
 * Settings > GitHub (docs/DESIGN.md 30): the token repo sessions use. Who it
 * is, which repositories it can see (searchable), and how to make one. The
 * token goes to the hub once and never comes back to the apps.
 */
import { useEffect, useState } from 'react';
import type { GithubStatusDto } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { toast } from '@/store/store';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Overlay';
import { LoadingRows } from '@/components/ui/EmptyState';
import { githubStatus, RepoList } from '@/features/github/RepoPicker';
import { errText, Group, Outcome, SettingRow } from './parts';

/** The page on github.com that makes a fine-grained token. */
const NEW_TOKEN = 'https://github.com/settings/personal-access-tokens/new';

export function GithubSection() {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [status, setStatus] = useState<GithubStatusDto>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmOff, setConfirmOff] = useState(false);
  const [replace, setReplace] = useState(false);
  useEffect(() => {
    void githubStatus(true).then(setStatus);
  }, []);

  if (!status) return <LoadingRows loading rows={4} />;

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const st = await api().githubConnect(token.trim());
      setStatus(st);
      setToken('');
      setReplace(false);
      void githubStatus(true);
      toast({ title: `Connected as @${st.login}.`, level: 'success' });
    } catch (e) {
      setError(errText(e));
    }
    setBusy(false);
  };

  const help = status.source === 'env' ? 'From CONCLAVE_GITHUB_TOKEN where the hub runs.' : status.source === 'mcp' ? 'Shared with the GitHub MCP server: the hub secret "github-pat". Sessions never see it.' : 'The token is the hub secret "github". Sessions never see it.';

  return (
    <div className="space-y-9">
      <Group title="Connection">
        {status.connected && (
          <SettingRow label={<Outcome word="Connected" tone="ok">as @{status.login}{status.name ? ` (${status.name})` : ''}</Outcome>} help={help}>
            {status.source === 'secret' && (
              <Button variant="outline" size={size} onClick={() => setConfirmOff(true)}>
                Disconnect
              </Button>
            )}
            {status.source === 'mcp' && !replace && (
              <Button variant="outline" size={size} onClick={() => setReplace(true)}>
                Connect a separate token
              </Button>
            )}
          </SettingRow>
        )}
        {(!status.connected || replace) && (
          <>
            {status.error && <SettingRow label={<Outcome word="Not working" tone="fault">{status.error}</Outcome>} />}
            <SettingRow
              stack
              label="Token"
              htmlFor="github-token"
              help={
                <>
                  A fine-grained token from{' '}
                  <a href={NEW_TOKEN} target="_blank" rel="noreferrer" className="link">
                    github.com
                  </a>{' '}
                  for the repositories you want, with Contents read and write, Pull requests read and write, and Metadata read. The hub checks it with GitHub before it keeps it.
                </>
              }
            >
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (token.trim()) void connect();
                }}
              >
                <Input id="github-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" className="flex-1" invalid={!!error} />
                <Button type="submit" variant="solid" size={size === 'sm' ? 'md' : size} disabled={!token.trim()} busy={busy ? 'Checking' : false}>
                  Connect
                </Button>
              </form>
              {error && <p className="m-0 mt-2 text-[12px] text-fault phone:text-[14px]">{error}</p>}
            </SettingRow>
          </>
        )}
        <SettingRow
          stack
          label="What the hub does with it"
          help="It clones a repository once per device, gives each repo session its own worktree and branch, pushes that branch and opens the pull request when you say so, and reads the pull request's state and checks. It never force pushes and never pushes to the default branch."
        />
      </Group>

      {status.connected && (
        <Group title="Repositories" count={status.repos} help="What the token can see, most recently pushed first. Start a session in one from Home: Code, then From GitHub.">
          <RepoList onPick={(r) => window.open(r.url, '_blank', 'noreferrer')} className="-mx-1 max-h-[420px] [&_[role=listbox]]:px-0" />
        </Group>
      )}

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Disconnect GitHub?"
        body="The hub forgets the token. Repo sessions keep their worktrees, but cannot push or open pull requests until you connect again."
        confirm="Disconnect"
        busy="Disconnecting"
        onConfirm={async () => {
          try {
            setStatus(await api().githubDisconnect());
            void githubStatus(true);
          } catch (e) {
            toast({ title: `Failed. ${errText(e)}`, level: 'error' });
          }
          setConfirmOff(false);
        }}
      />
    </div>
  );
}
