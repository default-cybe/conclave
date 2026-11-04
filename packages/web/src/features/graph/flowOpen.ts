/** Which session's flow canvas is open on this device (one at a time), like usePreviewOpen. Kept apart so the chat view does not load React Flow. */
import { create } from 'zustand';

export const useFlowOpen = create<{ id?: string }>(() => ({}));
export const toggleFlow = (id: string) => useFlowOpen.setState((s) => ({ id: s.id === id ? undefined : id }));
