/** Which session's flow canvas is open on this device (one at a time), like usePreviewOpen. Kept apart so the chat view does not load React Flow. */
import { create } from 'zustand';
import type { Session } from '@conclave/core/types';
import { programHref } from '@/features/canvas/model';

export const useFlowOpen = create<{ id?: string }>(() => ({}));
export const toggleFlow = (id: string) => useFlowOpen.setState((s) => ({ id: s.id === id ? undefined : id }));

/** A session's flow in Canvas mode: /canvas/program/<name> in the session's folder (docs/design/CANVAS-MODE.md). */
export const flowCanvasHref = (session: Pick<Session, 'device' | 'cwd'>, name: string) => programHref(name, session.device, session.cwd);
