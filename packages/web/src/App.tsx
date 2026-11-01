import { Children, isValidElement, lazy, Suspense, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { matchRoute, Redirect, Route, Router, Switch, useLocation, useRouter, type Parser } from 'wouter';
import { MOCK, connectClient, consumeHashToken, loadConnection, withoutConnectParam, type Connection } from './lib/api';
import { loadAll, startLive, stopLive, useHub } from './store/store';
import { isSetupPath, setupRedirect, useOnboarded } from './lib/onboarding';
import { onHubIdentityError } from './lib/identity';
import { keepTrying, reachHub, useReach, type Reached } from './lib/reach';
import { Shell } from './components/Shell';
import { OwnerOnly } from './components/OwnerOnly';
import { Toaster } from './components/ui/Toast';
import { PageBoundary } from './components/ErrorBoundary';
import { BootSplash, bootLaunch } from './components/BootSplash';
import { KnotRope } from './components/motion';
import { useDelayed, useIsMobile } from './lib/hooks';
import { isSettingsPath, useAppLocation, useAppSearch } from './lib/settingsRoute';
import { useIsOwner } from './lib/people';
import { ConnectScreen } from './features/connect/ConnectScreen';
import { StrangerScreen } from './features/connect/StrangerScreen';
import { ChatsPage } from './features/chat/ChatsPage';
import { SplitPage } from './features/chat/SplitPage';
import { ChatsRedirect, SessionRoute } from './features/conversation/routes';
import HomePage from './features/home/HomePage';
// loads on demand like the pages below; once Home has preloaded it, sending from Home opens it with no blank frame
import { ChatPageRoute } from './features/conversation/lazy';

const OnboardingPage = lazy(() => import('./features/onboarding/OnboardingPage'));
// an app's sign in request (claude.ai, ChatGPT) waiting on the owner: its own page, outside the shell
const ConsentPage = lazy(() => import('./features/connect/ConsentPage'));
const CONSENT_PATH = '/oauth/consent';
// an invite from the owner: set a password and join (docs/design/ACCOUNTS.md 4)
const InvitePage = lazy(() => import('./features/connect/InvitePage'));
const INVITE_PATH = /^\/invite\/([A-Za-z0-9_-]{20,64})$/;
const TasksPage = lazy(() => import('./features/tasks/TasksPage'));
const GoalsPage = lazy(() => import('./features/goals/GoalsPage'));
const AgentsPage = lazy(() => import('./features/agents/AgentsPage'));
const ExtensionsPage = lazy(() => import('./features/extensions/ExtensionsPage'));
const RoutinesPage = lazy(() => import('./features/routines/RoutinesPage'));
const WorkflowsPage = lazy(() => import('./features/workflows/WorkflowsPage'));
const MemoryPage = lazy(() => import('./features/memory/MemoryPage'));
const UsagePage = lazy(() => import('./features/usage/UsagePage'));
const DevicesPage = lazy(() => import('./features/devices/DevicesPage'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
// on a computer Settings opens over the page that was open (lib/settingsRoute.ts)
const SettingsOverlay = lazy(() => import('./features/settings/SettingsPage').then((m) => ({ default: m.SettingsOverlay })));
const ApprovalsPage = lazy(() => import('./features/chat/ApprovalsPage'));
// shares with friends: the list, and one share from a friend
const SharesPage = lazy(() => import('./features/friends/SharesPage'));
// projects shared with friends: the list, and one project
const SharedProjectsPage = lazy(() => import('./features/friends/SharedProjects'));
const MapPage = lazy(() => import('./features/map/MapPage'));
const TodayPage = lazy(() => import('./features/home/TodayPage'));
const MeetingPage = lazy(() => import('./features/meeting/MeetingPage'));
const Gallery = lazy(() => import('./components/dev/Gallery'));
const MotionPage = lazy(() => import('./components/dev/MotionGallery'));

/** stranger: an address answered with another key (docs/design/HUB-LOGIN-AND-IDENTITY.md). */
type Phase = 'boot' | 'connect' | 'ready' | 'stranger';

export function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [loc, navigate] = useLocation();
  const stranger = useReach((s) => s.stranger);
  const stopTrying = useRef<(() => void) | undefined>(undefined);
  /** The connection the app started with: the mock's is never saved. */
  const booted = useRef<Connection | undefined>(undefined);
  // the launch, once per cold start: the long one with the name on the first run, before Connect
  const [launch, setLaunch] = useState(() => bootLaunch(!MOCK && !loadConnection() && !location.hash.includes('token=')));
  const splash = launch && <BootSplash moment={launch} ready={phase !== 'boot'} onGone={() => setLaunch(null)} />;
  const withSplash = (node: ReactNode) => (
    <>
      {node}
      {splash}
    </>
  );

  const start = async (conn: Connection) => {
    stopTrying.current?.();
    useReach.setState({ stranger: undefined });
    stopLive();
    await connectClient(conn);
    // another hub may be behind this connection: chats shown before are refetched
    await loadAll({ transcripts: true });
    startLive();
    setPhase('ready');
    // signed in from a forced Connect screen (Sign out, Add account): a reload opens the app, not Connect again
    const clean = withoutConnectParam(location.pathname, location.search, location.hash);
    if (clean) history.replaceState(history.state, '', clean);
  };

  /** Not reached: a stranger gets its screen, a refused token the Connect screen, no answer the shell with the offline banner. */
  const unreached = async (r: Exclude<Reached, { kind: 'ok' }>, saved: Connection) => {
    stopTrying.current?.();
    if (r.kind === 'stranger' || r.kind === 'unchecked') {
      stopLive();
      useReach.setState({ stranger: r.kind === 'stranger' ? { address: r.address } : { address: saved.baseUrl, unchecked: r.message } });
      setPhase('stranger');
    } else if (r.kind === 'refused') setPhase('connect');
    else {
      await connectClient(saved);
      useHub.setState({ conn: 'closed' });
      setPhase('ready');
      stopTrying.current = keepTrying(saved, { back: (ok) => void start(ok.conn), lost: (lost) => void unreached(lost as Exclude<Reached, { kind: 'ok' }>, saved) });
    }
  };

  /** Reach the saved hub at its address or another one it gave. `only`: the one address the owner picked. */
  const boot = async (saved: Connection, only?: string): Promise<Reached> => {
    booted.current = saved;
    const r = await reachHub(saved, only);
    if (r.kind === 'ok') await start(r.conn);
    else if (!only || r.kind === 'refused') await unreached(r, saved);
    return r;
  };

  useEffect(() => {
    const fromHash = consumeHashToken();
    let conn = fromHash ?? loadConnection();
    const forceConnect = new URLSearchParams(location.search).has('connect');
    if (MOCK && !conn && !forceConnect) conn = { baseUrl: location.origin, token: 'mock', hubName: 'madx' };
    if (conn && !forceConnect) void boot(conn);
    else setPhase('connect');
    return () => {
      stopTrying.current?.();
      stopLive();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a request or the socket met an address that holds another key: nothing was sent, say so
  useEffect(
    () =>
      onHubIdentityError((e) => {
        stopTrying.current?.();
        stopLive();
        useReach.setState({ stranger: { address: e.address } });
        setPhase('stranger');
      }),
    [],
  );

  // service worker asks us to open a session from a notification
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && typeof e.data.to === 'string') navigate(e.data.to);
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [navigate]);

  // first run: a hub that has not been set up opens onboarding (the owner can skip); a member has nothing to set up
  const onboarded = useOnboarded();
  const owner = useIsOwner();
  const phone = useIsMobile();
  useEffect(() => {
    // setup changes the hub's own settings: a member who opens it from a link goes Home
    const to = phase === 'ready' && loc !== '/connect' && loc !== CONSENT_PATH && !INVITE_PATH.test(loc) ? setupRedirect(owner, onboarded, loc) : undefined;
    if (to) navigate(to, { replace: true });
  }, [phase, owner, onboarded, loc, navigate]);

  if (phase === 'boot') return withSplash(launch ? <div className="h-full bg-bg" /> : <Splash />);
  const invite = INVITE_PATH.exec(loc);
  if (invite)
    return withSplash(
      <>
        <Suspense fallback={<Splash />}>
          <InvitePage secret={invite[1]} onJoined={(c) => start(c).then(() => navigate('/', { replace: true }))} />
        </Suspense>
        <Toaster />
      </>,
    );
  const saved = phase === 'stranger' ? (loadConnection() ?? booted.current) : undefined;
  if (saved && stranger) return withSplash(<StrangerScreen address={stranger.address} unchecked={stranger.unchecked} conn={saved} onTry={(url) => boot(saved, url)} onPair={() => setPhase('connect')} />);
  if (phase === 'connect' || phase === 'stranger')
    return withSplash(
      <>
        {loc === CONSENT_PATH ? (
          <ConnectScreen onConnected={(c) => start(c)} title="Sign in to answer an app" lede="An app wants access to your Conclave. Connect to your hub first, then you choose what it may do." />
        ) : (
          <ConnectScreen onConnected={(c) => start(c)} />
        )}
        <Toaster />
      </>,
    );

  if (loc === CONSENT_PATH)
    return withSplash(
      <>
        <Suspense fallback={<Splash />}>
          <ConsentPage />
        </Suspense>
        <Toaster />
      </>,
    );

  if (isSetupPath(loc) || loc === '/connect')
    return withSplash(
      <>
        <Suspense fallback={<Splash />}>
          <Switch>
            <Route path="/connect">
              <ConnectScreen onConnected={(c) => start(c).then(() => navigate('/'))} />
            </Route>
            <Route component={OnboardingPage} />
          </Switch>
        </Suspense>
        <Toaster />
      </>,
    );

  // a computer draws the page under Settings with the place it was opened from (lib/settingsRoute.ts)
  const settingsOver = !phone && isSettingsPath(loc);
  return withSplash(
    <>
      <Router hook={useAppLocation} searchHook={useAppSearch}>
        <Shell>
          <PageBoundary>
            <PageFade>
            <Switch>
              <Route path="/" component={HomePage} />
              <Route path="/chat/:id?" component={ChatPageRoute} />
              <Route path="/sessions/split" component={SplitPage} />
              <Route path="/sessions" component={ChatsPage} />
              <Route path="/chats" component={ChatsRedirect} />
              <Route path="/s/:id" component={SessionRoute} />
              <Route path="/approvals" component={ApprovalsPage} />
              <Route path="/inbox" component={ApprovalsPage} />
              <Route path="/shares/:id?">
                <OwnerOnly title="Shares">
                  <SharesPage />
                </OwnerOnly>
              </Route>
              <Route path="/today" component={TodayPage} />
              <Route path="/projects/:id?">
                <OwnerOnly title="Shared projects">
                  <SharedProjectsPage />
                </OwnerOnly>
              </Route>
              <Route path="/you">
                <Redirect to="/settings" replace />
              </Route>
              <Route path="/tasks/:id?" component={TasksPage} />
              <Route path="/meetings/:id?" component={MeetingPage} />
              <Route path="/goals/:id?" component={GoalsPage} />
              <Route path="/agents/:name?" component={AgentsPage} />
              <Route path="/extensions/:tab?">
                <OwnerOnly title="Extensions">
                  <ExtensionsPage />
                </OwnerOnly>
              </Route>
              <Route path="/routines/:id?" component={RoutinesPage} />
              <Route path="/workflows/runs/:id?" component={WorkflowsPage} />
              <Route path="/workflows" component={WorkflowsPage} />
              <Route path="/memory/:tab?" component={MemoryPage} />
              <Route path="/usage" component={UsagePage} />
              <Route path="/map" component={MapPage} />
              <Route path="/devices" component={DevicesPage} />
              <Route path="/devices/:id/files" component={DevicesPage} />
              <Route path="/settings/:section/:item" component={SettingsPage} />
              <Route path="/settings/:section?" component={SettingsPage} />
              <Route path="/dev/ui" component={Gallery} />
              <Route path="/dev/motion" component={MotionPage} />
              <Route>
                <Redirect to="/" />
              </Route>
            </Switch>
            </PageFade>
          </PageBoundary>
        </Shell>
      </Router>
      {settingsOver && (
        <PageBoundary>
          <SettingsOverlay />
        </PageBoundary>
      )}
      <Toaster />
    </>,
  );
}

/**
 * A page change fades the new page in over --dur-3, keyed by the route the
 * Switch matches, so moving inside a page, or between two paths of one page
 * (/approvals and /inbox), keeps its state. No exit and no travel (SPEC 7).
 * The fill is backwards only, so nothing holds an opacity (and a stacking
 * context) after it lands.
 */
function PageFade({ children }: { children: ReactElement<{ children: ReactNode }> }) {
  const [loc] = useLocation();
  const { parser } = useRouter();
  return (
    <div key={pageKey(children.props.children, loc, parser)} className="anim-page flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );
}

/** The first route of a Switch that matches `path`; routes with one component share the first one's key. */
export function pageKey(routes: ReactNode, path: string, parser: Parser): number {
  const all = Children.toArray(routes).filter(isValidElement) as ReactElement<{ path?: string; component?: unknown }>[];
  const i = all.findIndex((r) => matchRoute(parser, r.props.path ?? '', path)[0]);
  const component = all[i]?.props.component;
  return component ? all.findIndex((r) => r.props.component === component) : i;
}

/**
 * Waiting with no launch to show (a page's code still loading, a boot after
 * the launch played): one knot that runs, and only after 300ms.
 */
function Splash() {
  const slow = useDelayed(true, 300);
  return (
    <div className="grid h-full place-items-center bg-bg text-fg" role="status" aria-label="Loading">
      {slow && <KnotRope moment="run" size={48} className="anim-fade" />}
    </div>
  );
}
