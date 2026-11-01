import type { Server } from 'bun';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import type { Auth, AuthInfo, RateLimiter } from './auth';
import type { ClientHub, ClientSocketData } from './ws/clients';
import type { DaemonHub, DaemonSocketData } from './ws/daemons';
import type { Gateway } from './gateway';
import type { OtlpIngest } from './otlp';
import type { RemoteAccess } from './remote';
import type { FailureGuard } from './guard';
import type { OAuthService } from './oauth';
import type { CliproxyManager } from './cliproxy';
import type { MemberPlansManager } from './cliproxy/member';
import type { HubKey } from './identity';
import type { PeerService } from './peer/service';
import type { MapLive } from '@conclave/core/map/live.ts';
import type { HubLogs } from '@conclave/core/logs/index.ts';
import type { UpdateService } from './update/service';

export type WsData = ClientSocketData | DaemonSocketData;

export type HonoEnv = {
  Bindings: Server<WsData>;
  Variables: { auth: AuthInfo };
};

/** Everything route handlers share. */
export interface ServerContext {
  engine: EngineApi;
  auth: Auth;
  clients: ClientHub;
  daemons: DaemonHub;
  gateway: Gateway;
  otlp: OtlpIngest;
  /** HMAC secret for signed approval links. */
  actionSecret: string;
  /** The hub's Ed25519 identity key (identity.ts). */
  identity: HubKey;
  /** /api/pair, /api/login and /api/daemon/register: 10 per minute per IP. */
  pairLimiter: RateLimiter;
  /** Failed webhook secrets per IP. */
  webhookLimiter: RateLimiter;
  /** Remote access: tunnels, the same network, the hub's addresses. */
  remote: RemoteAccess;
  /** Wrong tokens per IP: the 20th in 10 minutes blocks the address, longer each time. */
  authGuard: FailureGuard;
  /** Wrong pairing codes and passwords per IP: the 10th in 10 minutes blocks the address, longer each time. */
  pairGuard: FailureGuard;
  /** OAuth for /mcp: claude.ai and ChatGPT connectors (oauth/index.ts). */
  oauth: OAuthService;
  /** Subscription sign-in through CLIProxyAPI (cliproxy/index.ts). */
  cliproxy: CliproxyManager;
  /** Each member's own CLIProxyAPI (cliproxy/member.ts). */
  memberPlans: MemberPlansManager;
  /** Friends: other owners' hubs (peer/service.ts, docs/design/FRIENDS.md). */
  peer: PeerService;
  /** The Map's deltas: token and tool activity for clients that show it (routes-map.ts). */
  map: MapLive;
  /** The hub's log files, app lines and the export (routes-logs.ts, docs/DESIGN.md 33). */
  logs: HubLogs;
  /** Updates of the hub and its devices' daemons (update/service.ts, docs/DESIGN.md, Updates). */
  updates: UpdateService;
}
