/** The old graph pages (/workflows/graph/:id, a run's ?view=graph) open in Canvas (model.ts oldGraphRedirect). */
import type { ReactNode } from 'react';
import { Redirect, useLocation, useSearch } from 'wouter';
import { oldGraphRedirect } from './model';

/** Anything else on the route renders `fallback`; with none, Canvas's start page. */
export function OldGraph({ fallback }: { fallback?: ReactNode }) {
  const [loc] = useLocation();
  const to = oldGraphRedirect(loc, useSearch());
  if (to) return <Redirect to={to} replace />;
  return fallback ?? <Redirect to="/canvas" replace />;
}
