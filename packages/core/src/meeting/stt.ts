/**
 * Cloud speech to text for live meetings: the hub mints a short-lived
 * streaming credential, and the desktop streams each channel straight to the
 * provider with it (the Parakeet AI pattern). The API key stays on the hub.
 *
 * - AssemblyAI Universal-Streaming v3: GET /v3/token?expires_in_seconds=N
 *   with the raw key in Authorization; the token goes in the wss URL as
 *   ?token=. One token may open several sessions inside its window.
 * - Deepgram: POST /v1/auth/grant {ttl_seconds} with "Token <key>"; the JWT
 *   goes in the socket's Authorization: Bearer header. The socket stays open
 *   after the JWT expires.
 */
import type { SttChoice, SttToken } from './wire';

/** Secret names (hub secrets for the owner, the member's own values for a member). */
export const STT_SECRETS = { assemblyai: 'stt.assemblyai', deepgram: 'stt.deepgram' } as const;
export type SttProvider = keyof typeof STT_SECRETS;

/** Seconds a token may be redeemed in: both channels open right after the call. */
export const STT_TOKEN_TTL_S = 60;
const TIMEOUT_MS = 8000;

/** Endpoints; tests point them at a fake server. */
export const STT_HOSTS: Record<SttProvider, { api: string; ws: string }> = {
  assemblyai: { api: 'https://streaming.assemblyai.com', ws: 'wss://streaming.assemblyai.com' },
  deepgram: { api: 'https://api.deepgram.com', ws: 'wss://api.deepgram.com' },
};

/**
 * The provider to use: the config's choice, else the first one with a key (Deepgram, the
 * default, then AssemblyAI), else Deepgram, whose missing key the overlay then names. Local
 * only when it was chosen: it is slower and loads the computer, so it is never a fallback.
 */
export function sttChoice(configured: SttChoice | undefined, key: (p: SttProvider) => string | undefined): SttChoice {
  if (configured) return configured;
  if (key('assemblyai') && !key('deepgram')) return 'assemblyai';
  return 'deepgram';
}

export class SttError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  let res: Response | undefined;
  // two tries: a home router's DNS can stall one lookup for 5 s (getaddrinfo ETIMEOUT) and answer the next at once
  for (let attempt = 0; !res; attempt++) {
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= 1) throw new SttError(502, `${what} did not answer: ${(e as Error).message}`);
    }
  }
  const text = await res.text();
  if (!res.ok) {
    // the provider's own words, short: never echoes the key (it is not in the body)
    const why = text.replace(/\s+/g, ' ').slice(0, 200);
    const fix = what === 'Deepgram' && res.status === 403 ? ' Create a key with Member permission or higher in the Deepgram console.' : '';
    throw new SttError(res.status === 401 || res.status === 403 ? 409 : 502, `${what} refused the key (HTTP ${res.status})${why ? `: ${why}` : ''}.${fix}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new SttError(502, `${what} sent a reply that is not JSON`);
  }
}

/** Mint the token. Throws SttError (409: the key is refused; 502: the provider failed). */
export async function mintSttToken(provider: SttProvider, apiKey: string, now = Date.now()): Promise<SttToken> {
  const host = STT_HOSTS[provider];
  if (provider === 'assemblyai') {
    const body = await call(`${host.api}/v3/token?expires_in_seconds=${STT_TOKEN_TTL_S}`, { method: 'GET', headers: { authorization: apiKey } }, 'AssemblyAI');
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) throw new SttError(502, 'AssemblyAI sent no token');
    const ttl = typeof body.expires_in_seconds === 'number' ? body.expires_in_seconds : STT_TOKEN_TTL_S;
    const q = new URLSearchParams({ sample_rate: '16000', encoding: 'pcm_s16le', format_turns: 'true', token });
    return { provider, url: `${host.ws}/v3/ws?${q}`, token, expiresAt: now + ttl * 1000, sampleRate: 16000, encoding: 'pcm_s16le' };
  }
  const body = await call(`${host.api}/v1/auth/grant`, { method: 'POST', headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl_seconds: STT_TOKEN_TTL_S }) }, 'Deepgram');
  const token = typeof body.access_token === 'string' ? body.access_token : '';
  if (!token) throw new SttError(502, 'Deepgram sent no token');
  const ttl = typeof body.expires_in === 'number' ? body.expires_in : STT_TOKEN_TTL_S;
  const q = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
    smart_format: 'true',
  });
  return { provider, url: `${host.ws}/v1/listen?${q}`, token, expiresAt: now + ttl * 1000, sampleRate: 16000, encoding: 'pcm_s16le' };
}
