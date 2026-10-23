/**
 * Settings > Maps (maps/service.ts): which provider answers places and
 * directions, the Google key (stored on the hub, never shown again) with
 * its Test button and setup steps, the OpenStreetMap contact email and
 * servers, home, the default travel mode, which app links open, and the
 * daily cap with today's count.
 */
import { useEffect, useState } from 'react';
import type { MapsLinkApp, MapsProviderId, MapsSettingsDto, MapsSettingsPatch, MapsTestResult, TravelMode } from '@conclave/core/client';
import { api } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks';
import { Button } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Input, Segmented } from '@/components/ui/Field';
import { LoadingRows } from '@/components/ui/EmptyState';
import { toast } from '@/store/store';
import { errText, Group, Outcome, SettingRow } from './parts';

export const GOOGLE_APIS = [
  { name: 'Places API (New)', service: 'places.googleapis.com' },
  { name: 'Routes API', service: 'routes.googleapis.com' },
  { name: 'Geocoding API', service: 'geocoding-backend.googleapis.com' },
  { name: 'Maps Static API', service: 'static-maps-backend.googleapis.com' },
  { name: 'Time Zone API', service: 'timezone-backend.googleapis.com' },
];

/** The gcloud commands for the five APIs and a key restricted to them. */
export const GCLOUD = [
  `gcloud services enable ${GOOGLE_APIS.map((a) => a.service).join(' ')}`,
  `gcloud services api-keys create --display-name="Conclave hub" \\\n${GOOGLE_APIS.map((a) => `  --api-target=service=${a.service}`).join(' \\\n')}`,
  'gcloud services api-keys get-key-string KEY_ID',
].join('\n\n');

const API_WORDS: Record<string, string> = { places: 'places', routes: 'routes', geocode: 'address lookups', timezone: 'time zones', staticmap: 'maps', nominatim: 'searches', osrm: 'routes', tiles: 'tile checks' };

/** "12 of 300 calls: places 4, routes 6, maps 2." */
export function todayWords(s: Pick<MapsSettingsDto, 'today' | 'dailyCap'>): string {
  const parts = Object.entries(s.today.byApi)
    .filter(([, n]) => n)
    .map(([k, n]) => `${API_WORDS[k] ?? k} ${n}`);
  return `${s.today.calls} of ${s.dailyCap} calls${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}

export function MapsSection() {
  const [s, setS] = useState<MapsSettingsDto>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api()
      .mapsSettings()
      .then(setS)
      .catch((e) => setError(errText(e)));
  }, []);
  if (error) return <p className="text-[13px] text-fault">Could not load the maps settings. {error}</p>;
  if (!s) return <LoadingRows loading rows={6} />;
  return <Body s={s} onChange={setS} />;
}

function Body({ s, onChange }: { s: MapsSettingsDto; onChange: (s: MapsSettingsDto) => void }) {
  const mobile = useIsMobile();
  const size = mobile ? 'touch' : 'sm';
  const [key, setKey] = useState('');
  const [home, setHome] = useState(s.home?.address ?? '');
  const [email, setEmail] = useState(s.osm.email ?? '');
  const [cap, setCap] = useState(String(s.dailyCap));
  const [servers, setServers] = useState({ nominatimUrl: s.osm.nominatimUrl, osrmUrl: s.osm.osrmUrl, tileUrl: s.osm.tileUrl });
  const [busy, setBusy] = useState<string>();
  const [test, setTest] = useState<MapsTestResult>();

  const call = async (what: string, fn: () => Promise<MapsSettingsDto>): Promise<MapsSettingsDto | undefined> => {
    setBusy(what);
    let out: MapsSettingsDto | undefined;
    try {
      out = await fn();
      onChange(out);
    } catch (e) {
      toast({ title: `Could not save. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
    return out;
  };
  const patch = (what: string, p: MapsSettingsPatch) => call(what, () => api().setMapsSettings(p));
  const runTest = async () => {
    setBusy('test');
    setTest(undefined);
    try {
      setTest(await api().testMaps());
      onChange(await api().mapsSettings());
    } catch (e) {
      toast({ title: `The test did not run. ${errText(e)}`, level: 'error' });
    }
    setBusy(undefined);
  };

  const homeDirty = home.trim() !== (s.home?.address ?? '');
  const emailDirty = email.trim() !== (s.osm.email ?? '');
  const capDirty = cap.trim() !== String(s.dailyCap);
  const capOk = /^\d{1,6}$/.test(cap.trim());
  const serversDirty = servers.nominatimUrl !== s.osm.nominatimUrl || servers.osrmUrl !== s.osm.osrmUrl || servers.tileUrl !== s.osm.tileUrl;
  const auto = !s.chosen;

  return (
    <div className="space-y-9">
      <Group title="Provider" help="Places, directions and maps in chats and the day plan come from one provider. Google Maps has ratings, opening hours, public transport and traffic, and needs a key with billing. OpenStreetMap needs no key and has none of those.">
        <SettingRow label="Provider" help={auto ? `Now ${s.provider === 'google' ? 'Google Maps, because a key is set' : 'OpenStreetMap, because no Google key is set'}.` : 'Chosen here.'}>
          <Segmented<MapsProviderId>
            label="Provider"
            size={mobile ? 'touch' : 'sm'}
            value={s.provider}
            onChange={(v) => void patch('provider', { provider: v })}
            options={[
              { value: 'google', label: 'Google Maps' },
              { value: 'osm', label: 'OpenStreetMap' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Test" help="One small call to each service the provider uses. It counts toward the daily cap.">
          <Button size={size} busy={busy === 'test' ? 'Testing' : false} onClick={() => void runTest()}>
            Test
          </Button>
        </SettingRow>
        {test && (
          <ul className="m-0 list-none space-y-1.5 p-0 py-3" aria-label="Test results">
            {test.steps.map((st) => (
              <li key={st.api} className="text-[13px] leading-[1.45] phone:text-[14px]">
                <Outcome word={st.ok ? 'Works' : 'Failed'} tone={st.ok ? 'ok' : 'fault'}>
                  <span className="text-fg-2">{st.name}.</span> {st.ok ? st.message.replace(/^Works\.\s*/, '') : st.message}
                </Outcome>
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Google Maps key" help="The key stays on the hub. Apps get only results and pictures, never the key, and tools never see it. From a terminal: conclave secret google-maps.">
        <SettingRow label="Key" help={s.google.keySet ? (s.google.keyFrom === 'env' ? 'Set in the hub environment (GOOGLE_MAPS_API_KEY).' : 'Set, stored on the hub.') : 'Not set.'} top>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Input mono type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.google.keySet ? 'Paste a new key' : 'AIza...'} aria-label="Google Maps API key" className="w-[200px]!" size="sm" />
            <Button
              variant="solid"
              size={size}
              disabled={!key.trim()}
              busy={busy === 'key' ? 'Saving' : false}
              onClick={async () => {
                if (await call('key', () => api().setMapsKey(key.trim()))) setKey('');
              }}
            >
              Save
            </Button>
            {s.google.keySet && s.google.keyFrom !== 'env' && (
              <Button variant="danger" size={size} busy={busy === 'rmkey' ? 'Removing' : false} onClick={() => void call('rmkey', () => api().setMapsKey(null))}>
                Remove
              </Button>
            )}
          </div>
        </SettingRow>
        <div className="py-3.5">
          <div className="text-[13.5px] font-medium text-fg phone:text-[15px]">Set up a key</div>
          <ol className="mt-1.5 mb-3 list-decimal space-y-1 pl-5 text-[12.5px] leading-[1.5] text-fg-2 phone:text-[14px]">
            <li>In the Google Cloud console, pick or create a project.</li>
            <li>Turn on billing for it, and add a budget alert in Billing, Budgets and alerts, such as 5 dollars a month.</li>
            <li>Enable the five APIs: {GOOGLE_APIS.map((a) => a.name).join(', ')}.</li>
            <li>In APIs and services, Credentials, create an API key. Restrict it to those five APIs. Leave application restrictions at None, or set the hub's IP address.</li>
            <li>Paste the key above and press Test.</li>
          </ol>
          <p className="mb-1.5 text-[12px] text-fg-3 phone:text-[13px]">Or with gcloud, in the project:</p>
          <CodeBlock code={GCLOUD} lang="bash" wrap />
        </div>
      </Group>

      <Group title="OpenStreetMap" help="Search through Nominatim, routes through OSRM, and maps drawn on the hub from OpenStreetMap tiles. The public servers are run by volunteers for light use: the hub makes at most one search a second and keeps tiles for a week.">
        <SettingRow label="Contact email" help="The public servers ask every app for a way to reach whoever runs it. Needed for them; your own servers do not need it." top>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.org" aria-label="Contact email" className="w-[240px]!" size="sm" />
            {emailDirty && (
              <Button variant="solid" size={size} busy={busy === 'email' ? 'Saving' : false} onClick={() => void patch('email', { osm: { email: email.trim() || null } })}>
                {email.trim() ? 'Save' : 'Clear'}
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Servers" help={s.osm.publicServers ? 'The public OpenStreetMap servers. The OSRM demo routes cars only, so walking and cycling times come from the distance. Use your own for anything more than light use.' : 'Your own servers.'} stack>
          <div className="grid gap-2">
            {(['nominatimUrl', 'osrmUrl', 'tileUrl'] as const).map((k) => (
              <Input key={k} mono value={servers[k]} onChange={(e) => setServers({ ...servers, [k]: e.target.value })} aria-label={{ nominatimUrl: 'Nominatim URL', osrmUrl: 'OSRM URL', tileUrl: 'Tile URL' }[k]} size="sm" spellCheck={false} />
            ))}
          </div>
          {serversDirty && (
            <div className="mt-2">
              <Button variant="solid" size={size} busy={busy === 'servers' ? 'Saving' : false} onClick={() => void patch('servers', { osm: { nominatimUrl: servers.nominatimUrl.trim() || null, osrmUrl: servers.osrmUrl.trim() || null, tileUrl: servers.tileUrl.trim() || null } })}>
                Save servers
              </Button>
            </div>
          )}
        </SettingRow>
      </Group>

      <Group title="Travel">
        <SettingRow label="Home" help={s.home ? `Found: ${s.home.lat.toFixed(4)}, ${s.home.lng.toFixed(4)}${s.home.zone ? `, ${s.home.zone}` : ''}. Directions start here, and leave-by times count from here.` : 'An address, or "lat,lng". Directions start here, and leave-by times count from here.'} top>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Input value={home} onChange={(e) => setHome(e.target.value)} placeholder="Street 1, City" aria-label="Home" className="w-[240px]!" size="sm" />
            {homeDirty && (
              <Button
                variant="solid"
                size={size}
                busy={busy === 'home' ? 'Finding' : false}
                onClick={async () => {
                  const out = await patch('home', { home: home.trim() || null });
                  if (out) setHome(out.home?.address ?? '');
                }}
              >
                {home.trim() ? 'Save' : 'Clear'}
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Travel mode" help="What directions and leave-by times use unless you say otherwise.">
          <Segmented<TravelMode>
            label="Travel mode"
            size={mobile ? 'touch' : 'sm'}
            value={s.mode}
            onChange={(v) => void patch('mode', { mode: v })}
            options={[
              { value: 'walk', label: 'Walk' },
              { value: 'transit', label: 'Transit' },
              { value: 'drive', label: 'Drive' },
              { value: 'bicycle', label: 'Bicycle' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Links open in" help="The app the Open and Directions buttons on cards open.">
          <Segmented<MapsLinkApp>
            label="Links open in"
            size={mobile ? 'touch' : 'sm'}
            value={s.links}
            onChange={(v) => void patch('links', { links: v })}
            options={[
              { value: 'google', label: 'Google Maps' },
              { value: 'apple', label: 'Apple Maps' },
            ]}
          />
        </SettingRow>
      </Group>

      <Group title="Limit">
        <SettingRow label="Daily cap" help="Calls to the provider per day across the hub. Answers from the cache do not count. 0 turns maps off." top>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Input mono inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Daily cap" className="w-[96px]!" size="sm" invalid={!capOk} />
            {capDirty && (
              <Button variant="solid" size={size} disabled={!capOk} busy={busy === 'cap' ? 'Saving' : false} onClick={() => void patch('cap', { dailyCap: Number(cap.trim()) })}>
                Save
              </Button>
            )}
          </div>
        </SettingRow>
        <SettingRow label="Today">
          <span className="text-[13px] text-fg-2 phone:text-[14px]">{todayWords(s)}</span>
        </SettingRow>
      </Group>
    </div>
  );
}
