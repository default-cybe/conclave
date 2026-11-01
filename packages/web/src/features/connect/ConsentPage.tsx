/**
 * The consent screen for an app that wants /mcp (docs/design/MCP-OAUTH.md):
 * claude.ai, ChatGPT or another MCP client. The hub's /oauth/authorize sends
 * the browser here with ?request=<id>. The owner is signed in (App shows
 * Connect first when not), reads who is asking, where the answer goes and
 * what the app may do, and allows or denies. The answer goes back with the
 * one time consent value the hub gave this page, and the hub replies with
 * the address to return to.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { OAuthConsentDto, OAuthScope } from '@conclave/core/client';
import { ApiError } from '@conclave/core/client';
import { api, MOCK } from '@/lib/api';
import { useDelayed, useIsMobile, useNow } from '@/lib/hooks';
import { useHub } from '@/store/store';
import { cn } from '@/lib/text';
import { Brand } from '@/components/brand/Mark';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Field';
import { SectionHeading } from '@/components/ui/Section';

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; req: OAuthConsentDto }
  | { kind: 'gone'; message?: string }
  | { kind: 'stale' }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; decision: 'allow' | 'deny'; host: string };

function minutesLeft(until: number, now: number): string {
  const m = Math.round((until - now) / 60_000);
  return m < 1 ? 'less than a minute' : `${m} min`;
}

/** Same scheme, host, port and path: the answer goes where the page said. */
function sameTarget(url: string, shown: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(shown);
    return a.origin === b.origin && a.pathname === b.pathname && (a.protocol === 'https:' || a.protocol === 'http:');
  } catch {
    return false;
  }
}

export default function ConsentPage() {
  const id = new URLSearchParams(location.search).get('request') ?? '';
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [picked, setPicked] = useState<Set<OAuthScope>>(new Set());
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string>();
  const hubName = useHub((s) => s.hub?.name);
  const now = useNow(15_000);
  const mobile = useIsMobile();
  const slow = useDelayed(view.kind === 'loading');

  const load = () => {
    if (!id) return setView({ kind: 'gone' });
    setView({ kind: 'loading' });
    api()
      .oauthRequest(id)
      .then((req) => {
        setPicked(new Set(req.scopes.map((s) => s.id)));
        setView({ kind: 'ready', req });
      })
      .catch((e) => setView(e instanceof ApiError && e.status === 404 ? { kind: 'gone' } : { kind: 'failed', message: e instanceof Error ? e.message : String(e) }));
  };
  useEffect(load, [id]);

  useEffect(() => {
    document.title = view.kind === 'ready' ? `${view.req.app.loopback ? 'A program on your computer' : view.req.app.host} wants access, Conclave` : 'Sign in request, Conclave';
  }, [view]);

  const answer = async (decision: 'allow' | 'deny') => {
    if (view.kind !== 'ready') return;
    setBusy(decision);
    setError(undefined);
    try {
      const { redirect } = await api().oauthDecide(view.req.id, { decision, consent: view.req.consent, ...(decision === 'allow' ? { scopes: [...picked] } : {}) });
      // go only where this page said the answer goes
      if (!sameTarget(redirect, view.req.redirectUri)) throw new Error('The hub answered with a different address than this page showed. Nothing was sent. Start again from the app.');
      setView({ kind: 'done', decision, host: view.req.app.host });
      // the mock stays here so the page can be looked at
      if (!MOCK) window.location.assign(redirect);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setView({ kind: 'stale' });
      else if (e instanceof ApiError && e.status === 404) setView({ kind: 'gone' });
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const expired = view.kind === 'ready' && view.req.expiresAt <= now;

  return (
    <div className="h-full overflow-y-auto bg-bg pt-safe pb-safe">
      <header className="flex h-14 items-center gap-4 border-b border-rule px-10 phone:h-[52px] phone:px-4 md:max-lg:px-6">
        <Brand size={15} />
        <span className="text-[13px] text-fg-3 phone:hidden">Sign in request</span>
        {hubName && <span className="ml-auto truncate text-[13px] text-fg-3 phone:text-[14px]">Signed in to {hubName}</span>}
      </header>

      <main className="mx-auto w-full max-w-[600px] px-10 pt-14 pb-16 phone:px-4 phone:pt-8 phone:pb-10 md:max-lg:px-6">
        {view.kind === 'loading' && <p className={cn('t-body text-fg-3', !slow && 'invisible')}>Reading the request.</p>}

        {(view.kind === 'gone' || expired) && (
          <Message title="This request is no longer open" body="It expired or was already answered. Start connecting again from the app.">
            <ButtonLink href="/" variant="outline" size={mobile ? 'touch' : 'md'}>
              Open Conclave
            </ButtonLink>
          </Message>
        )}

        {view.kind === 'stale' && (
          <Message title="This page is out of date" body="The request was opened again somewhere else. Reload it and choose again.">
            <Button variant="outline" size={mobile ? 'touch' : 'md'} onClick={load}>
              Reload
            </Button>
          </Message>
        )}

        {view.kind === 'failed' && (
          <Message title="Could not read the request" body={view.message}>
            <Button variant="outline" size={mobile ? 'touch' : 'md'} onClick={load}>
              Try again
            </Button>
          </Message>
        )}

        {view.kind === 'done' && (
          <Message
            title={view.decision === 'allow' ? 'Allowed' : 'Denied'}
            body={MOCK ? `The app would now get your answer at ${view.host}.` : `Taking you back to ${view.host}.`}
          />
        )}

        {view.kind === 'ready' && !expired && <Request req={view.req} picked={picked} setPicked={setPicked} busy={busy} error={error} onAnswer={answer} now={now} mobile={mobile} />}
      </main>
    </div>
  );
}

function Message({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <section aria-live="polite">
      <h1 className="t-page m-0 text-fg phone:text-[22px]">{title}</h1>
      <p className="t-body mt-2 max-w-[60ch] text-fg-2">{body}</p>
      {children && <div className="mt-6">{children}</div>}
    </section>
  );
}

function Request({
  req,
  picked,
  setPicked,
  busy,
  error,
  onAnswer,
  now,
  mobile,
}: {
  req: OAuthConsentDto;
  picked: Set<OAuthScope>;
  setPicked: (s: Set<OAuthScope>) => void;
  busy: 'allow' | 'deny' | null;
  error?: string;
  onAnswer: (d: 'allow' | 'deny') => void;
  now: number;
  mobile: boolean;
}) {
  const { app } = req;
  const none = picked.size === 0;
  const toggle = (s: OAuthScope, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(s);
    else next.delete(s);
    setPicked(next);
  };
  return (
    <article aria-labelledby="consent-title">
      <h1 id="consent-title" className="t-step m-0 text-fg [overflow-wrap:anywhere]">
        {app.loopback ? (
          'A program on your computer wants access to your Conclave'
        ) : (
          <>
            <span className="font-mono text-[0.86em] tracking-normal">{app.host}</span> wants access to your Conclave
          </>
        )}
      </h1>
      <p className="t-body mt-3 max-w-[60ch] text-fg-2">
        It calls itself <span className="text-fg">{app.name}</span>.{' '}
        {app.kind === 'cimd' && app.identity ? (
          <>
            Its details come from <span className="font-mono text-[0.93em] text-fg">{app.identity}</span>.
          </>
        ) : (
          'Conclave did not check this name.'
        )}
      </p>
      {app.warning && <p className="t-body mt-3 max-w-[60ch] text-warn">{app.warning}</p>}

      <section className="mt-9" aria-labelledby="consent-scopes">
        <SectionHeading id="consent-scopes">It will be able to</SectionHeading>
        <div className="rows">
          {req.scopes.map((s) => (
            <Checkbox
              key={s.id}
              checked={picked.has(s.id)}
              onChange={(v) => toggle(s.id, v)}
              className="py-3 phone:py-3.5"
              label={<span className="text-[14px] leading-[1.4] phone:text-[15px]">{s.label}</span>}
            />
          ))}
        </div>
        <p className="t-meta mt-2.5 text-fg-3">Clear a line to leave it out. You can revoke access any time in Settings, Connected apps.</p>
      </section>

      <section className="mt-8">
        <p className="t-body m-0 text-fg-2">When you answer, you go back to</p>
        <p className="mt-1 font-mono text-[12.5px] leading-[1.5] break-all text-fg phone:text-[13px]">{req.redirectUri}</p>
        <p className="t-body mt-4 text-fg-2">Only allow this if you started connecting {app.name} yourself just now.</p>
      </section>

      {error && (
        <p role="alert" className="t-body mt-6 text-fault">
          {error}
        </p>
      )}

      <div className={cn('mt-8 flex items-center gap-3', mobile && 'flex-col items-stretch')}>
        <Button variant="solid" size={mobile ? 'touch' : 'lg'} disabled={none || !!busy} busy={busy === 'allow' ? 'Allowing' : false} onClick={() => onAnswer('allow')} full={mobile}>
          Allow
        </Button>
        <Button variant="quiet" size={mobile ? 'touch' : 'lg'} disabled={!!busy} busy={busy === 'deny' ? 'Denying' : false} onClick={() => onAnswer('deny')} full={mobile}>
          Deny
        </Button>
        <span className={cn('t-meta text-fg-3', mobile ? 'pt-1 text-center' : 'ml-auto')}>{none ? 'Pick at least one, or press Deny.' : `Ends in ${minutesLeft(req.expiresAt, now)}.`}</span>
      </div>
    </article>
  );
}
