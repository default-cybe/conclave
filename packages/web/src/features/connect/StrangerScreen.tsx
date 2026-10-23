/**
 * An address answered with another key (docs/design/HUB-LOGIN-AND-IDENTITY.md):
 * a reused LAN address, or a tunnel name that changed hands. The client sent
 * nothing with the token in it. The owner can try the hub's other addresses
 * or pair again. Full screen, outside the shell.
 */
import { useState } from 'react';
import type { Connection } from '@/lib/api';
import type { Reached } from '@/lib/reach';
import { addressOrder, hostOf, savedAddresses, thisPage, transportWords } from '@/lib/remote';
import { useIsMobile } from '@/lib/hooks';
import { cn } from '@/lib/text';
import { Mark } from '@/components/brand/Mark';
import { Button } from '@/components/ui/Button';
import { Toaster } from '@/components/ui/Toast';

const RESULT: Record<Exclude<Reached['kind'], 'ok'>, string> = {
  offline: 'No answer.',
  stranger: 'Not your hub either.',
  refused: 'Refused the sign-in.',
  unchecked: 'Cannot check it here.',
};

/**
 * `unchecked`: this phone cannot check the hub's key at all (no Ed25519
 * before iOS 17), in the words to show. Then the screen says that and offers
 * to try again.
 */
export function StrangerScreen({ address, unchecked, conn, onTry, onPair }: { address: string; unchecked?: string; conn: Connection; onTry: (url: string) => Promise<Reached>; onPair: () => void }) {
  const mobile = useIsMobile();
  const [busy, setBusy] = useState<string>();
  const [results, setResults] = useState<Record<string, string>>({});
  const others = addressOrder(conn.baseUrl, savedAddresses(conn), thisPage()).filter((u) => u !== address.replace(/\/+$/, ''));

  const tryOne = async (url: string) => {
    if (busy) return;
    setBusy(url);
    const r = await onTry(url);
    // an address that answers takes the app away from this screen
    if (r.kind !== 'ok') setResults((x) => ({ ...x, [url]: RESULT[r.kind as keyof typeof RESULT] }));
    setBusy(undefined);
  };

  return (
    <div className="h-full overflow-y-auto bg-bg pt-safe pb-safe">
      <main className="mx-auto flex min-h-full w-full max-w-[480px] flex-col px-6 pt-[clamp(32px,10vh,96px)] pb-8 phone:px-5">
        <Mark height={22} />
        <h1 className="mt-7 text-[28px] leading-[1.2] font-semibold tracking-[-0.015em] text-balance text-fg" style={{ fontStretch: '104%' }}>
          {unchecked ? 'Conclave cannot check your hub.' : 'This address is not your hub.'}
        </h1>
        {unchecked ? (
          <p className="mt-3 text-[15px] leading-[1.5] text-fg-2">{unchecked}</p>
        ) : (
          <p className="mt-3 text-[15px] leading-[1.5] text-pretty text-fg-2">
            Conclave did not send your sign-in. <span className="mono text-fg">{hostOf(address) || address}</span> answered with another key, so it may be a different machine that has your hub's old address.
          </p>
        )}

        {unchecked ? (
          <div className="mt-7">
            <Button variant="solid" size={mobile ? 'touch' : 'lg'} busy={busy ? 'Trying' : false} onClick={() => void tryOne(conn.baseUrl)}>
              Try again
            </Button>
            {results[conn.baseUrl] && <p className="mt-3 text-[14px] text-fault">{results[conn.baseUrl]}</p>}
          </div>
        ) : (
          <section aria-labelledby="stranger-other" className="mt-9">
            <h2 id="stranger-other" className="t-section border-b border-rule-2 pb-2.5 text-fg">
              Try another address
            </h2>
            {others.length === 0 ? (
              <p className="py-3 text-[14px] text-fg-3">Your hub gave no other address. Pair again with a code from the hub.</p>
            ) : (
              <ul className="rows m-0 list-none p-0">
                {others.map((url) => (
                  <li key={url}>
                    <button
                      type="button"
                      onClick={() => void tryOne(url)}
                      disabled={!!busy}
                      className="flex min-h-14 w-full items-center gap-3 py-2.5 text-left transition-colors duration-[var(--dur-1)] hov:bg-hover disabled:cursor-default"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[14px] text-fg">{hostOf(url) || url}</span>
                        <span className="mt-0.5 block text-[13px] text-fg-3">{transportWords(url)}</span>
                      </span>
                      <span className={cn('shrink-0 text-[13px]', busy === url ? 'text-signal' : results[url] ? 'text-fault' : 'text-fg-2')}>{busy === url ? 'Trying' : (results[url] ?? 'Try')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <div className="mt-auto pt-10">
          <Button variant="outline" size={mobile ? 'touch' : 'lg'} full onClick={onPair}>
            Pair again
          </Button>
          <p className="mt-3 text-center text-[13px] leading-[1.45] text-fg-3">Open Devices on your hub for a new code, or log in with its address and password.</p>
        </div>
      </main>
      <Toaster />
    </div>
  );
}
