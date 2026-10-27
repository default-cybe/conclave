/**
 * Who may call each route (docs/design/ACCOUNTS.md 4 and 11). One table, one
 * middleware. Every /api route the app registers must be here: a test lists
 * the app's routes and fails on one that is missing, and until a route is
 * added it is the owner's only.
 *
 *   public   no token (pairing, login, health, identity, webhooks and signed links with their own secret)
 *   admin    the owner of the hub only: hub settings, providers, extensions, remote access, friends, People
 *   self     any account; the handler works on the caller's account only (lists, creates, own settings)
 *   hub      any account; hub wide facts that are safe to show
 *   own      any account, and each id in the path named here must be one of the caller's own,
 *            checked before the handler runs: someone else's id answers 404, the same as an unknown one
 *
 * Adding a route: put it here with one of these. A new kind of id for `own`
 * is one lookup in OWNERS below.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { EngineApi } from '@conclave/core/engine/api.ts';
import { OWNER_ID } from '@conclave/core/people/context.ts';
import { alertsOf } from '@conclave/core/alerts/attached.ts';
import type { HonoEnv, ServerContext } from './context';
import { OWNER_ONLY } from './scope';

/** Kinds of id a path can carry, each with the account it belongs to. */
export type OwnedKind =
  | 'session'
  | 'routine'
  | 'task'
  | 'memory'
  | 'device'
  | 'client'
  | 'approval'
  | 'question'
  | 'project'
  | 'pathPrefix'
  | 'goal'
  | 'importBatch'
  | 'workflowRun'
  | 'alert'
  | 'pimAccount'
  | 'proposal'
  | 'preset';

export type Rule = 'public' | 'admin' | 'self' | 'hub' | { own: Record<string, OwnedKind> };

const own = (params: Record<string, OwnedKind>): Rule => ({ own: params });
const SESSION = own({ id: 'session' });

/** Every /api route and its rule. Keys are "METHOD /path" exactly as the app registers them. */
export const ROUTE_POLICY: Record<string, Rule> = {
  // ----- hub, pairing and login -----
  'GET /api/ws': 'self',
  'GET /api/daemon': 'public',
  'GET /api/health': 'public',
  'GET /api/info': 'hub',
  'POST /api/pairing': 'self',
  'POST /api/pair': 'public',
  'GET /api/identity': 'public',
  'POST /api/login': 'public',
  'GET /api/auth/password': 'self',
  'PUT /api/auth/password': 'self',
  'DELETE /api/auth/password': 'self',
  'POST /api/daemon/register': 'public',
  'POST /api/daemon/pairing': 'self',
  'POST /api/daemon/unpair': 'public',
  'GET /api/clients': 'self',
  'DELETE /api/clients/:id': own({ id: 'client' }),

  // ----- accounts (routes-people.ts) -----
  'GET /api/me': 'self',
  'PATCH /api/me': 'self',
  'GET /api/invite/:secret': 'public',
  'POST /api/invite/:secret': 'public',
  'GET /api/people': 'admin',
  'POST /api/people': 'admin',
  'GET /api/people/:id': 'admin',
  'PATCH /api/people/:id': 'admin',
  'DELETE /api/people/:id': 'admin',
  'POST /api/people/:id/password': 'admin',
  'POST /api/people/:id/invite': 'admin',
  'POST /api/people/:id/workspace': 'admin',
  'GET /api/people/:id/clients': 'admin',
  'DELETE /api/people/:id/clients/:client': 'admin',

  // ----- sessions -----
  'GET /api/sessions': 'self',
  'POST /api/sessions': 'self',
  'GET /api/sessions/:id': SESSION,
  'PATCH /api/sessions/:id': SESSION,
  // Move to main list: the same rule as editing the session
  'POST /api/sessions/:id/main-list': SESSION,
  'DELETE /api/sessions/:id': SESSION,
  'POST /api/sessions/:id/move': SESSION,
  'GET /api/sessions/:id/location': SESSION,
  // Move to hub writes to the hub's own disk: the owner's only
  'GET /api/sessions/:id/hub-copy': 'admin',
  'DELETE /api/sessions/:id/hub-copy': 'admin',
  'GET /api/sessions/:id/hub-copy/back': 'admin',
  'POST /api/sessions/:id/hub-copy/back': 'admin',
  'POST /api/sessions/:id/fork': SESSION,
  'GET /api/sessions/:id/messages': SESSION,
  'POST /api/sessions/:id/messages': SESSION,
  'GET /api/sessions/:id/queue': SESSION,
  'DELETE /api/sessions/:id/queue/:pendingId': SESSION,
  'POST /api/sessions/:id/queue/:pendingId/send': SESSION,
  // a side question: the same rule as sending a message
  'POST /api/sessions/:id/btw': SESSION,
  'POST /api/sessions/:id/abort': SESSION,
  'POST /api/sessions/:id/pause': SESSION,
  'POST /api/sessions/:id/resume': SESSION,
  'POST /api/sessions/:id/rewind': SESSION,
  'POST /api/sessions/:id/second-opinion': SESSION,
  'POST /api/sessions/:id/handoff': SESSION,
  // "Try the next model" on a refused reply (Refusal fallback)
  'POST /api/sessions/:id/next-model': SESSION,
  'POST /api/sessions/:id/retry-provider': SESSION,
  'GET /api/sessions/:id/switch-estimate': SESSION,
  'POST /api/sessions/:id/compact': SESSION,
  'GET /api/sessions/:id/context': SESSION,
  'POST /api/sessions/:id/command': SESSION,
  'GET /api/sessions/:id/todos': SESSION,
  'GET /api/sessions/:id/checkpoints': SESSION,
  'POST /api/sessions/:id/checkpoints/:checkpointId/restore': SESSION,
  'GET /api/sessions/:id/diff': SESSION,
  'GET /api/sessions/:id/export': SESSION,
  // a file a ShareFile call shared: the owner, or a member on their own session
  'GET /api/sessions/:id/files/:toolUseId': SESSION,
  'GET /api/sessions/:id/bundle': SESSION,
  'GET /api/sessions/:id/repo': SESSION,
  'POST /api/sessions/:id/repo/push': SESSION,
  'GET /api/sessions/:id/repo/pr-draft': SESSION,
  'POST /api/sessions/:id/repo/pr': SESSION,
  'POST /api/sessions/:id/repo/cleanup': SESSION,
  'POST /api/sessions/:id/repo/merge': SESSION,
  'GET /api/search': 'self',

  // ----- folders across devices -----
  'POST /api/projects/identify': 'self',
  'GET /api/projects': 'self',
  'GET /api/projects/:id': own({ id: 'project' }),
  'PUT /api/projects/:id/locations': own({ id: 'project' }),
  'DELETE /api/projects/:id/locations': own({ id: 'project' }),
  'GET /api/devices/:id/folders': own({ id: 'device' }),
  'DELETE /api/path-prefixes/:id': own({ id: 'pathPrefix' }),

  // ----- GitHub: each account its own token -----
  'GET /api/github': 'self',
  'PUT /api/github/token': 'self',
  'DELETE /api/github/token': 'self',
  'GET /api/github/repos': 'self',
  'GET /api/github/repos/:owner/:name/branches': 'self',
  'POST /api/github/sessions': 'self',
  // "Run in a worktree": the handlers check the device is the caller's
  'GET /api/worktrees/folder': 'self',
  'POST /api/worktrees/sessions': 'self',

  // ----- approvals and questions -----
  'GET /api/approvals': 'self',
  'POST /api/approvals/:id/act': 'public',
  'GET /api/approvals/:id/act': 'public',
  'POST /api/approvals/:id': own({ id: 'approval' }),
  'GET /api/questions': 'self',
  'POST /api/questions/:id': own({ id: 'question' }),

  // ----- models, agents, extensions: the hub's, set by the owner -----
  'GET /api/models': 'self',
  // asks CLIProxyAPI and starts each harness that is on, to read its model list
  'POST /api/models/refresh': 'admin',
  'POST /api/providers/:provider/test': 'admin',
  // probe an endpoint the owner typed (Custom provider): owner only, the owner can already point a provider anywhere
  'POST /api/providers/probe': 'admin',
  'POST /api/providers/probe-model': 'admin',
  'GET /api/agents': 'self',
  'PUT /api/agents/:name': 'admin',
  'DELETE /api/agents/:name': 'admin',
  'GET /api/agents/:name/default': 'admin',
  'GET /api/skills': 'self',
  'GET /api/commands': 'self',
  'GET /api/skills/learned': 'admin',
  'GET /api/skills/learned/:name': 'admin',
  'PATCH /api/skills/learned/:name': 'admin',
  'DELETE /api/skills/learned/:name': 'admin',
  'GET /api/mcp': 'admin',
  'POST /api/mcp': 'admin',
  'POST /api/mcp/import': 'admin',
  'PATCH /api/mcp/:name': 'admin',
  'DELETE /api/mcp/:name': 'admin',
  'POST /api/mcp/:name/restart': 'admin',
  'POST /api/mcp/:name/test': 'admin',
  'GET /api/mcp/:name/tools': 'admin',
  'POST /api/mcp/:name/call': 'admin',
  'GET /api/mcp/:name/connect': 'admin',
  'POST /api/mcp/:name/connect': 'admin',
  'GET /api/plugins': 'admin',
  'POST /api/plugins': 'admin',
  'GET /api/plugins/:name': 'admin',
  'PATCH /api/plugins/:name': 'admin',
  'DELETE /api/plugins/:name': 'admin',
  'POST /api/plugins/:name/update': 'admin',
  'GET /api/marketplace': 'admin',
  'POST /api/marketplace': 'admin',
  'GET /api/marketplace/search': 'admin',
  'POST /api/reload': 'admin',
  'GET /api/extensions/overview': 'admin',
  'GET /api/extensions/inventory': 'admin',
  'GET /api/extensions/sources': 'admin',
  'GET /api/tools': 'admin',
  'POST /api/tools/check': 'admin',
  'GET /api/hooks': 'admin',
  'POST /api/hooks/test': 'admin',
  'PUT /api/hooks': 'admin',
  'POST /api/hooks/lint': 'admin',
  'GET /api/hooks/recipes': 'admin',
  'GET /api/hooks/recipes/:id': 'admin',
  'POST /api/hooks/recipes/:id/test': 'admin',
  'POST /api/hooks/recipes/:id/install': 'admin',
  'DELETE /api/hooks/recipes/:id': 'admin',
  'GET /api/hooks/builtin': 'admin',
  'PATCH /api/hooks/builtin/:id': 'admin',
  'POST /api/hooks/import': 'admin',
  'GET /api/trust': 'admin',
  'POST /api/trust': 'admin',
  'POST /api/sync-clis': 'admin',

  // ----- tasks -----
  'GET /api/tasks': 'self',
  'POST /api/tasks': 'self',
  'PATCH /api/tasks/:id': own({ id: 'task' }),
  'DELETE /api/tasks/:id': own({ id: 'task' }),
  'POST /api/tasks/:id/start': own({ id: 'task' }),
  'POST /api/tasks/import': 'admin',

  // ----- routines -----
  'GET /api/routines': 'self',
  'GET /api/routines/templates': 'hub',
  'GET /api/routines/preview': 'hub',
  'POST /api/routines': 'self',
  'PATCH /api/routines/:id': own({ id: 'routine' }),
  'DELETE /api/routines/:id': own({ id: 'routine' }),
  'POST /api/routines/:id/run': own({ id: 'routine' }),
  'GET /api/routines/:id/runs': own({ id: 'routine' }),
  'POST /api/routines/:id/upgrade': own({ id: 'routine' }),
  'POST /api/routines/:id/trigger': 'public',
  // suggestions make agents in the owner's own folder and run on the owner's devices
  'GET /api/routines/suggestions': 'admin',
  'POST /api/routines/suggestions/:id/add': 'admin',

  // ----- the assistant: goals, preferences, Today -----
  'GET /api/goals': 'self',
  'POST /api/goals': 'self',
  'GET /api/goals/:id': own({ id: 'goal' }),
  'PATCH /api/goals/:id': own({ id: 'goal' }),
  'DELETE /api/goals/:id': own({ id: 'goal' }),
  'POST /api/goals/:id/entries': own({ id: 'goal' }),
  'DELETE /api/goals/:id/entries/:entryId': own({ id: 'goal' }),
  'GET /api/assistant': 'self',
  'GET /api/assistant/home': 'self',
  'PATCH /api/assistant/prefs': 'self',
  'PUT /api/assistant/heartbeat': 'self',
  'PUT /api/assistant/reflection': 'self',
  'GET /api/assistant/reflect': 'self',
  'PUT /api/assistant/reflect': 'self',
  // one reflection now, with a model call on the hub's keys: the owner's
  'POST /api/assistant/reflect/run': 'admin',
  'GET /api/assistant/today': 'self',
  'POST /api/assistant/today/answer': 'self',

  // ----- maps: the key and the home are the owner's -----
  'GET /api/maps': 'admin',
  'PATCH /api/maps': 'admin',
  'PUT /api/maps/key': 'admin',
  'POST /api/maps/test': 'admin',
  'GET /api/maps/leave-by': 'self',
  'GET /api/maps/image/:id': 'self',

  // ----- web search: the engine and its keys are the hub's, set by the owner -----
  'GET /api/websearch': 'admin',
  'PATCH /api/websearch': 'admin',
  'PUT /api/websearch/key': 'admin',
  'POST /api/websearch/test': 'admin',

  // ----- memory -----
  'GET /api/memory': 'self',
  'GET /api/memory/search': 'self',
  'POST /api/memory': 'self',
  'PATCH /api/memory/:id': own({ id: 'memory' }),
  'DELETE /api/memory/:id': own({ id: 'memory' }),
  'GET /api/memory/digest': 'self',
  'PUT /api/memory/digest': 'self',
  // the memory map reads the hub's Basic Memory connection too: the owner only
  'GET /api/memory/graph': 'admin',
  'GET /api/memory/connections': 'self',
  'GET /api/memory/connections/presets': 'self',
  'POST /api/memory/connections/test': 'self',
  'POST /api/memory/connections': 'self',
  'GET /api/memory/connections/:id': 'self',
  'PATCH /api/memory/connections/:id': 'self',
  'DELETE /api/memory/connections/:id': 'self',
  'POST /api/memory/connections/:id/test': 'self',
  'POST /api/memory/connections/:id/sync': 'self',
  'DELETE /api/memory/connections/:id/imported': 'self',
  'GET /api/memory/connections/:id/connect': 'self',
  'POST /api/memory/connections/:id/group': 'self',
  'POST /api/memory/import': 'self',
  'GET /api/memory/export': 'self',
  'POST /api/memory/export': 'self',
  'GET /api/memory/review': 'self',
  'POST /api/memory/review': 'self',
  'GET /api/memory/stats': 'self',

  // ----- usage and limits -----
  'GET /api/usage': 'self',
  'GET /api/usage/recent': 'self',
  'GET /api/limits': 'self',
  'POST /api/limits/refresh': 'admin',

  // ----- devices -----
  'GET /api/devices': 'self',
  'GET /api/devices/here': 'self',
  'PATCH /api/devices/:id': own({ id: 'device' }),
  'DELETE /api/devices/:id': own({ id: 'device' }),
  'GET /api/devices/:device/files': own({ device: 'device' }),
  'GET /api/devices/:device/file': own({ device: 'device' }),

  // ----- chat import -----
  'GET /api/import/scan': 'self',
  'POST /api/import/estimate': 'self',
  'GET /api/import/batches': 'self',
  'POST /api/import/batches': 'self',
  'GET /api/import/batches/:id': own({ id: 'importBatch' }),
  'POST /api/import/batches/:id/pause': own({ id: 'importBatch' }),
  'POST /api/import/batches/:id/resume': own({ id: 'importBatch' }),
  'POST /api/import/batches/:id/cancel': own({ id: 'importBatch' }),
  'POST /api/import/batches/:id/undo': own({ id: 'importBatch' }),
  'POST /api/import/upload': 'self',
  'POST /api/import/merge-duplicates': 'self',
  'POST /api/import/sessions/:sessionId/sync': own({ sessionId: 'session' }),
  'GET /api/import/retention': 'self',
  'POST /api/import/retention': 'self',
  'GET /api/import/sessions': 'self',
  'POST /api/import': 'self',
  'GET /api/import/offers': 'self',
  'POST /api/import/offers/:device/dismiss': own({ device: 'device' }),

  // ----- workflows -----
  'GET /api/workflows': 'self',
  'GET /api/workflows/:id': 'self',
  // preset handlers filter by the caller's account; workflow ids name library entries, not owned rows
  'GET /api/workflows/:id/presets': 'self',
  'POST /api/workflows/:id/presets': 'self',
  'DELETE /api/workflows/:id/presets/:presetId': 'self',
  'GET /api/workflows/runs': 'self',
  'POST /api/workflows/runs': 'self',
  'GET /api/workflows/runs/:id': own({ id: 'workflowRun' }),
  'POST /api/workflows/runs/:id/pause': own({ id: 'workflowRun' }),
  'POST /api/workflows/runs/:id/resume': own({ id: 'workflowRun' }),
  'POST /api/workflows/runs/:id/stop': own({ id: 'workflowRun' }),
  'POST /api/workflows/runs/:id/rerun': own({ id: 'workflowRun' }),
  'POST /api/workflows/runs/:id/calls/:seq/skip': own({ id: 'workflowRun' }),
  'POST /api/workflows/runs/:id/calls/:seq/worktree': own({ id: 'workflowRun' }),
  'POST /api/workflows/runs/:id/findings/:findingId': own({ id: 'workflowRun' }),

  // ----- gateway keys serve the owner's CLIs -----
  'GET /api/gateway/keys': 'admin',
  'POST /api/gateway/keys': 'admin',
  'DELETE /api/gateway/keys/:id': 'admin',

  // ----- config, secrets, notifications, audit -----
  'GET /api/config': 'self',
  'PATCH /api/config': 'admin',
  'PUT /api/secrets': 'self',
  'GET /api/notify/channels': 'hub',
  'POST /api/notify/test': 'self',
  'GET /api/notify/vapid': 'hub',
  'POST /api/notify/subscribe': 'self',
  'POST /api/notify/unsubscribe': 'self',
  'GET /api/notify/devices': 'self',
  'DELETE /api/notify/devices/:id': 'self',
  'GET /api/audit': 'self',
  'GET /api/backup': 'admin',
  'POST /api/restore': 'admin',

  // ----- the Discover catalog installs into the hub -----
  'GET /api/catalog': 'admin',
  'GET /api/catalog/search': 'admin',
  'GET /api/catalog/items/:id': 'admin',
  'GET /api/catalog/status': 'admin',
  'POST /api/catalog/refresh': 'admin',
  'POST /api/catalog/preview': 'admin',
  'POST /api/catalog/install': 'admin',
  // runs a shipped item's setup on the hub as the hub's user: the owner only, never a member or a device
  'POST /api/catalog/items/:id/setup': 'admin',
  'GET /api/catalog/installed': 'admin',
  'POST /api/catalog/updates/check': 'admin',
  'POST /api/catalog/installed/:id/update-preview': 'admin',
  'POST /api/catalog/installed/:id/update': 'admin',
  'POST /api/catalog/installed/:id/rollback': 'admin',
  'DELETE /api/catalog/installed/:id': 'admin',

  // ----- remote access, subscriptions and provider accounts are the hub's -----
  'GET /api/remote': 'admin',
  'PUT /api/remote': 'admin',
  'POST /api/remote/restart': 'admin',
  'POST /api/remote/cloudflare': 'admin',
  'GET /api/remote/cloudflare/zones': 'admin',
  'POST /api/remote/stable': 'admin',
  'DELETE /api/remote/stable': 'admin',
  'GET /api/remote/tailscale': 'admin',
  'POST /api/subscriptions/update': 'admin',
  // the owner's work on the hub's CLIProxyAPI, a member's on their own (cliproxy/member.ts); a member's PUT only turns theirs on
  'GET /api/subscriptions': 'self',
  'PUT /api/subscriptions': 'self',
  'POST /api/subscriptions/signin': 'self',
  'GET /api/subscriptions/signin/:state': 'self',
  'POST /api/subscriptions/signin/:state/callback': 'self',
  'DELETE /api/subscriptions/signin/:state': 'self',
  'DELETE /api/subscriptions/accounts/:name': 'self',
  'POST /api/subscriptions/accounts/:name/refresh': 'self',
  'GET /api/accounts': 'self',
  'POST /api/accounts/refresh': 'self',
  'PUT /api/accounts/order': 'self',
  'PATCH /api/accounts/:id': 'self',
  'DELETE /api/accounts/:id': 'self',
  'POST /api/accounts/:id/try': 'self',
  'PUT /api/accounts/:id/prefix': 'self',

  // ----- alerts -----
  'GET /api/alerts': 'self',
  'POST /api/alerts/:id': own({ id: 'alert' }),

  // ----- claude.ai and ChatGPT connectors: a grant is the account that approved it -----
  'GET /api/oauth/requests/:id': 'self',
  'POST /api/oauth/requests/:id': 'self',
  'GET /api/oauth/apps': 'self',
  'DELETE /api/oauth/apps/:id': 'self',
  'GET /api/mcp-server/snippets': 'self',

  // ----- friends: the hub identity is the owner's (docs/design/ACCOUNTS.md 7) -----
  'GET /api/friends': 'admin',
  'GET /api/friends/reachability': 'admin',
  'GET /api/friends/outbox': 'admin',
  'GET /api/friends/inbox': 'admin',
  'POST /api/friends/invites': 'admin',
  'POST /api/friends/accept': 'admin',
  'POST /api/friends/outbox/:msgId/retry': 'admin',
  'DELETE /api/friends/outbox/:msgId': 'admin',
  'GET /api/friends/:id': 'admin',
  'PATCH /api/friends/:id': 'admin',
  'DELETE /api/friends/:id': 'admin',
  'POST /api/friends/:id/accept': 'admin',
  'POST /api/friends/:id/decline': 'admin',
  'POST /api/friends/:id/verify': 'admin',
  'PUT /api/friends/:id/grants': 'admin',
  'POST /api/friends/:id/confirm-key': 'admin',
  'POST /api/friends/:id/sync': 'admin',
  'POST /api/friends/:id/read': 'admin',
  'POST /api/friends/:id/notes': 'admin',
  'POST /api/shares/preview': 'admin',
  'POST /api/shares': 'admin',
  'GET /api/shares/sent': 'admin',
  'GET /api/shares/sent/:id': 'admin',
  'POST /api/shares/sent/:id/update': 'admin',
  'DELETE /api/shares/sent/:id': 'admin',
  'GET /api/shares/received': 'admin',
  'GET /api/shares/received/:id': 'admin',
  'POST /api/shares/received/:id/accept': 'admin',
  'POST /api/shares/received/:id/decline': 'admin',
  'GET /api/shares/received/:id/view': 'admin',
  'POST /api/shares/received/:id/fork': 'admin',
  'GET /api/shares/received/:id/handoff': 'admin',
  'POST /api/shares/received/:id/handoff': 'admin',
  'POST /api/shares/received/:id/reference': 'admin',
  'POST /api/shares/received/:id/apply-plan': 'admin',
  'POST /api/shares/received/:id/apply': 'admin',

  'POST /api/friends/add': 'admin',
  'POST /api/friends/mail-invite': 'admin',
  'GET /api/friends/settings': 'admin',
  'PUT /api/friends/settings': 'admin',
  'DELETE /api/friends/blocked/:fp': 'admin',
  'POST /api/friends/:id/block': 'admin',

  // ----- shared projects are between the owner's hub and friends' hubs, like shares -----
  'GET /api/shared-projects': 'admin',
  'POST /api/shared-projects': 'admin',
  'GET /api/shared-projects/:id': 'admin',
  'PATCH /api/shared-projects/:id': 'admin',
  'DELETE /api/shared-projects/:id': 'admin',
  'POST /api/shared-projects/:id/accept': 'admin',
  'POST /api/shared-projects/:id/decline': 'admin',
  'POST /api/shared-projects/:id/members': 'admin',
  'DELETE /api/shared-projects/:id/members/:fp': 'admin',
  'POST /api/shared-projects/:id/notes': 'admin',
  'PATCH /api/shared-projects/:id/items/:item': 'admin',
  'DELETE /api/shared-projects/:id/items/:item': 'admin',
  'GET /api/shared-projects/:id/items/:item/history': 'admin',
  'GET /api/shared-projects/:id/memory-candidates': 'admin',
  'POST /api/shared-projects/:id/memories': 'admin',
  'POST /api/shared-projects/:id/chats': 'admin',
  'GET /api/shared-projects/:id/code': 'admin',
  'POST /api/shared-projects/:id/sync': 'admin',
  'POST /api/shared-projects/:id/read': 'admin',

  // ----- calendar and mail: each account its own accounts, secrets and proposals; the hub's OAuth clients are the owner's -----
  'GET /api/pim': 'self',
  'POST /api/pim/accounts/caldav': 'self',
  'POST /api/pim/accounts/imap': 'self',
  'PATCH /api/pim/accounts/:id': own({ id: 'pimAccount' }),
  'POST /api/pim/accounts/:id/test': own({ id: 'pimAccount' }),
  'DELETE /api/pim/accounts/:id': own({ id: 'pimAccount' }),
  'PUT /api/pim/oauth/clients': 'admin',
  'POST /api/pim/oauth/google/start': 'self',
  'POST /api/pim/oauth/google/finish': 'self',
  'GET /api/pim/oauth/google/callback': 'public',
  'POST /api/pim/oauth/microsoft/start': 'self',
  // a sign-in lives in its account's service only: another account's id is unknown there
  'GET /api/pim/oauth/flows/:id': 'self',
  'DELETE /api/pim/oauth/flows/:id': 'self',
  'GET /api/proposals': 'self',
  'POST /api/proposals/:id/approve': own({ id: 'proposal' }),
  'POST /api/proposals/:id/decline': own({ id: 'proposal' }),

  // ----- watches and the browser sign-in use the hub's Chromium: the owner's for now -----
  'GET /api/watches': 'admin',
  'GET /api/watches/:id': 'admin',
  'GET /api/watches/:id/items/:item/image': 'admin',
  'GET /api/watches/sessions/:session/items/:item/image': 'admin',
  'GET /api/browser': 'admin',
  'POST /api/browser/signin': 'admin',
  'GET /api/browser/signin/:id/frame': 'admin',
  'POST /api/browser/signin/:id/input': 'admin',
  'POST /api/browser/signin/:id/done': 'admin',
  'DELETE /api/browser/signin/:id': 'admin',
  // a chat session's live view and Take over: the owner only, and only that session's page
  'GET /api/browser/sessions/:session': 'admin',
  'GET /api/browser/sessions/:session/frame': 'admin',
  'DELETE /api/browser/sessions/:session/frame': 'admin',
  'POST /api/browser/sessions/:session/input': 'admin',
  'POST /api/browser/sessions/:session/control': 'admin',
  // installs on the hub as its user, and the proxy whose login is the hub's secret: the owner only
  'POST /api/browser/setup': 'admin',
  // the root helper's one action, as root through sudo: the owner only, audited
  'POST /api/browser/libs': 'admin',
  'PUT /api/browser/profiles/:name': 'admin',
  'PUT /api/browser/proxy': 'admin',
  'POST /api/browser/proxy/test': 'admin',
  // saved logins (their passwords are the owner's secrets), forgetting a site and deleting a profile: the owner only
  'POST /api/browser/logins': 'admin',
  'PUT /api/browser/logins/:id': 'admin',
  'DELETE /api/browser/logins/:id': 'admin',
  'POST /api/browser/profiles/:name/forget': 'admin',
  // imported cookies are sign-ins: the owner only
  'POST /api/browser/profiles/:name/cookies': 'admin',
  'DELETE /api/browser/profiles/:name': 'admin',

  // ----- updates: the hub's install and its devices' daemons are the owner's (docs/DESIGN.md, Updates) -----
  'GET /api/update': 'admin',
  'POST /api/update/check': 'admin',
  'POST /api/update/apply': 'admin',
  'PUT /api/update/settings': 'admin',
  'GET /api/devices/updates': 'admin',
  'POST /api/devices/:id/update': 'admin',

  // ----- logs are the hub's: the owner reads them; any app sends its own lines, stamped with its account -----
  'GET /api/logs': 'admin',
  'GET /api/logs/tail': 'admin',
  'GET /api/logs/errors': 'admin',
  'PUT /api/logs/debug': 'admin',
  'GET /api/logs/export': 'admin',
  'POST /api/logs/client': 'self',

  // ----- the Map -----
  'GET /api/map': 'self',
};

/**
 * Routes outside /api with their own check: the model gateway (gateway keys),
 * OTLP ingest, Conclave's MCP endpoint and its OAuth server, friends' hubs.
 * Listed so the route test knows every route the app has.
 */
export const OWN_AUTH_ROUTES = [/^ALL \/gw\//, /^POST \/v1\//, /^ALL \/mcp$/, /^(ALL|GET|POST) \/(\.well-known|oauth)\//, /^(GET|POST|PUT) \/peer\/v1\//];

/** Whose calendar or mail account an id is: each account keeps its list in kv (pim/store.ts), under its own keys. */
function pimAccountOwner(db: EngineApi['repos']['db'], id: string): string | undefined {
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = db.query("SELECT key, value FROM kv WHERE key = 'pim.accounts' OR key LIKE 'acct:%:pim.accounts'").all() as Array<{ key: string; value: string }>;
  } catch {
    return undefined;
  }
  for (const r of rows) {
    let list: Array<{ id?: string }> = [];
    try {
      list = JSON.parse(r.value) as Array<{ id?: string }>;
    } catch {
      continue;
    }
    if (!Array.isArray(list) || !list.some((a) => a?.id === id)) continue;
    return r.key === 'pim.accounts' ? OWNER_ID : r.key.slice('acct:'.length, -':pim.accounts'.length);
  }
  return undefined;
}

/** The account a row of each kind belongs to, or undefined when there is no such row. */
export function ownerOf(ctx: ServerContext, kind: OwnedKind, id: string): string | undefined {
  const engine = ctx.engine;
  const db = engine.repos.db;
  const col = (sql: string): string | undefined => {
    try {
      return (db.query(sql).get(id) as { account_id?: string | null } | null)?.account_id ?? undefined;
    } catch {
      return undefined;
    }
  };
  switch (kind) {
    case 'session':
      return engine.sessionAccount(id);
    case 'routine':
      return engine.routines.get(id)?.accountId;
    case 'task':
      return engine.repos.tasks.get(id)?.accountId;
    case 'memory':
      return col('SELECT account_id FROM memories WHERE id = ?');
    case 'device':
      return engine.repos.devices.accountOf(id);
    case 'client':
      return ctx.auth.clients.get(id)?.accountId;
    case 'approval':
    case 'question':
      return engine.pendingAccount(id);
    case 'project':
      return col('SELECT account_id FROM projects WHERE id = ?');
    case 'pathPrefix': {
      let dev: string | undefined;
      try {
        dev = (db.query('SELECT from_device FROM path_prefixes WHERE id = ?').get(id) as { from_device: string } | null)?.from_device;
      } catch {
        dev = undefined; // no projects store on this hub
      }
      return dev ? engine.repos.devices.accountOf(dev) : undefined;
    }
    case 'goal':
      return col('SELECT account_id FROM goals WHERE id = ?');
    case 'importBatch':
      return col('SELECT account_id FROM import_batches WHERE id = ?');
    case 'workflowRun':
      return col('SELECT s.account_id FROM workflow_runs w JOIN sessions s ON s.id = w.session_id WHERE w.id = ?');
    case 'proposal':
      return col('SELECT account_id FROM pim_proposals WHERE id = ?');
    case 'preset':
      return col('SELECT account_id FROM workflow_presets WHERE id = ?');
    case 'pimAccount':
      return pimAccountOwner(db, id);
    case 'alert': {
      const a = alertsOf(engine)?.list().find((x) => x.id === id);
      return a ? (engine.sessionAccount(a.sessionId) ?? OWNER_ID) : undefined;
    }
  }
}

/** The route the request will reach (the first matched one that is not a wildcard middleware), and its index. */
function targetRoute(c: Context<HonoEnv>): { path: string; method: string; index: number } | undefined {
  const routes = c.req.matchedRoutes;
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (r.method === 'ALL' && (r.path === '*' || r.path.endsWith('/*'))) continue;
    return { path: r.path, method: r.method, index: i };
  }
  return undefined;
}

/** The rule for a route key, or undefined for a route nobody put in the table. */
export function ruleFor(method: string, path: string): Rule | undefined {
  return ROUTE_POLICY[`${method} ${path}`] ?? (method === 'HEAD' ? ROUTE_POLICY[`GET ${path}`] : undefined);
}

/**
 * The middleware: after the bearer check, before the handler. Members are
 * refused admin routes and routes not in the table; an id in the path of an
 * `own` route that is someone else's answers 404 for everyone, the owner too.
 */
export function routePolicy(ctx: ServerContext): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const target = targetRoute(c);
    if (!target) return next();
    const rule = ruleFor(c.req.method, target.path);
    const who = c.get('auth');
    if (!who) return next(); // a public route: no token, its own check
    if (rule === 'public' || rule === 'self' || rule === 'hub') return next();
    if (rule === undefined || rule === 'admin') {
      if (who.role !== 'owner') return c.json({ error: OWNER_ONLY }, 403);
      return next();
    }
    // own: read the target route's params (the middleware's own index has none)
    const saved = c.req.routeIndex;
    let params: Record<string, string>;
    try {
      c.req.routeIndex = target.index;
      params = c.req.param() as Record<string, string>;
    } finally {
      c.req.routeIndex = saved;
    }
    for (const [name, kind] of Object.entries(rule.own)) {
      const id = params[name];
      if (id === undefined) continue;
      const owner = ownerOf(ctx, kind, id);
      // unknown and someone else's read the same; the handler says "not found" for unknown ids itself
      if (owner !== undefined && owner !== who.accountId) return c.json({ error: 'not found' }, 404);
    }
    return next();
  };
}

/** For tests and docs: the owner's id. */
export const POLICY_OWNER = OWNER_ID;

export type { EngineApi };
