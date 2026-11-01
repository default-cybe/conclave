/**
 * A screen that throws while it renders shows a short note with Reload and
 * Try again instead of a blank page, and the error goes to the hub's log
 * files (lib/clientLog.ts): its message and the components it was in, never
 * what the screen showed. resetKey (the route) clears it when the owner
 * moves to another page.
 */
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { clientLog } from '@/lib/clientLog';
import { Button } from './ui/Button';

/** "SettingsPage < SectionBody < DesktopSettings": the first components of a React component stack. */
export function componentPath(stack: string | null | undefined, n = 4): string | undefined {
  if (!stack) return undefined;
  const names = [...stack.matchAll(/^\s*(?:at\s+)?([A-Z][A-Za-z0-9_$]*)/gm)].map((m) => m[1]);
  return names.length ? names.slice(0, n).join(' < ') : undefined;
}

interface Props {
  children: ReactNode;
  /** A change clears the error (the current route). */
  resetKey?: string;
  /** full: the whole window (the app's root); page: inside the shell. */
  scope?: 'full' | 'page';
}

interface State {
  error?: Error;
  key?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // another page: start over
    if (props.resetKey !== state.key) return { key: props.resetKey, error: undefined };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = componentPath(info.componentStack);
    clientLog('error', 'render.error', { scope: this.props.scope ?? 'page', ...(where ? { where } : {}), path: location.pathname.replace(/\/(ses|wf|run|dev|apr|fr|cl)_[A-Za-z0-9]+/g, '/:id').slice(0, 120) }, error);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const full = this.props.scope === 'full';
    return (
      <div role="alert" className={full ? 'grid h-full place-items-center bg-bg px-6 text-fg' : 'px-6 py-10'}>
        <div className="max-w-[46ch]">
          <h1 className="m-0 text-[17px] font-medium text-fg">Something went wrong on this screen.</h1>
          <p className="mt-2 mb-0 text-[14px] leading-[1.45] text-fg-2">It goes in the hub's logs. Try again, or reload the app.</p>
          <div className="mt-5 flex gap-2">
            <Button variant="solid" onClick={() => location.reload()}>
              Reload
            </Button>
            <Button variant="outline" onClick={() => this.setState({ error: undefined })}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

/** The pages inside the shell: a page that throws shows the note there, and another page clears it. Loads lazy pages like Suspense. */
export function PageBoundary({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  return (
    <ErrorBoundary resetKey={loc}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}
