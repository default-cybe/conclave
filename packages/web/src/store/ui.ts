/** UI state and per-device preferences (appearance, list grouping, panels). */
import { create } from 'zustand';
import type { SessionMode } from '@conclave/core/types';
import { applyTextSize, textSizeOf, type TextSize } from '@/lib/textSize';

export type Theme = 'system' | 'dark' | 'light';
export type LogoTone = 'brand' | 'mono';
export type Density = 'comfortable' | 'compact';
export type MotionPref = 'system' | 'reduce';
/** Group by: date is Recent (time, and on the desktop list the state groups). */
export type ListGroup = 'date' | 'project' | 'agent' | 'task' | 'device';
/** Group by for the sidebar's Code sessions (desktop sidebar and phone drawer). Chats and the assistant's go by time. */
export type SideGroup = 'project' | 'device' | 'time';

interface Prefs {
  theme: Theme;
  /** Appearance: logos in brand colors where the model is the subject, or one color everywhere. */
  logos: LogoTone;
  density: Density;
  motion: MotionPref;
  /** Appearance: the conversation's text, Small to Larger (lib/textSize.ts). */
  textSize: TextSize;
  listGroup: ListGroup;
  showArchived: boolean;
  pinnedOnly: boolean;
  contextOpen: boolean;
  juryLayout: 'tabs' | 'columns';
  /** The sidebar's Code sessions: by project, device or time. */
  sideGroup: SideGroup;
  /** Sidebar groups folded shut, by group key ("p:prj_x"). */
  foldedGroups: string[];
  /** The session panel's cards that are open, by card id. */
  cards: Record<string, boolean>;
}

export interface PageHeaderInfo {
  /** Title shown in the phone header on inner pages. */
  title: string;
  /** Where the phone back chevron goes. */
  back?: string;
  /** A text action at the right of the phone header ("Details"), replacing the hub state. */
  action?: import('react').ReactNode;
}

interface UiState extends Prefs {
  /** Resolved theme, kept in sync with html[data-theme]. */
  resolved: 'dark' | 'light';
  paletteOpen: boolean;
  paletteMode: 'root' | 'model' | 'agent' | 'mode' | 'search' | 'routine' | 'workflow';
  /** Prefill for the palette input, e.g. ">" for actions only. */
  paletteQuery?: string;
  shortcutsOpen: boolean;
  newChatOpen: boolean;
  /** context panel drawer on phones and tablets (not persisted) */
  drawerOpen: boolean;
  /** Phones: the side panel is open (components/PhoneFrame.tsx). */
  panelOpen: boolean;
  newChatPreset?: { agent?: string; model?: string; taskId?: string; prompt?: string; device?: string; mode?: SessionMode };
  /** Set by pages through usePageHeader. */
  header?: PageHeaderInfo;
  set: (p: Partial<UiState>) => void;
}

const PREFS_KEY = 'conclave.ui';
const APPEARANCE_KEY = 'conclave.appearance';

function loadPrefs(): Prefs {
  const base: Prefs = {
    theme: 'system',
    logos: 'brand',
    density: 'comfortable',
    motion: 'system',
    textSize: 'default',
    listGroup: 'date',
    showArchived: false,
    pinnedOnly: false,
    contextOpen: true,
    juryLayout: 'columns',
    sideGroup: 'project',
    foldedGroups: [],
    cards: { context: true, tasks: true },
  };
  try {
    const a = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return { ...base, ...p, ...a, textSize: textSizeOf(a.textSize) };
  } catch {
    return base;
  }
}

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: light)') : undefined;

function resolve(theme: Theme): 'dark' | 'light' {
  if (theme === 'system') return media?.matches ? 'light' : 'dark';
  return theme;
}

const initial = loadPrefs();

export const useUi = create<UiState>((set) => ({
  ...initial,
  resolved: resolve(initial.theme),
  paletteOpen: false,
  paletteMode: 'root',
  shortcutsOpen: false,
  newChatOpen: false,
  drawerOpen: false,
  panelOpen: false,
  set: (p) => set(p),
}));

// persist prefs on change
useUi.subscribe((s, prev) => {
  const keys: Array<keyof Prefs> = ['theme', 'logos', 'density', 'motion', 'textSize', 'listGroup', 'showArchived', 'pinnedOnly', 'contextOpen', 'juryLayout', 'sideGroup', 'foldedGroups', 'cards'];
  if (!keys.some((k) => s[k] !== prev[k])) return;
  try {
    const { theme, logos, density, motion, textSize, listGroup, showArchived, pinnedOnly, contextOpen, juryLayout, sideGroup, foldedGroups, cards } = s;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ listGroup, showArchived, pinnedOnly, contextOpen, juryLayout, sideGroup, foldedGroups, cards }));
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme, logos, density, motion, textSize }));
  } catch {
    /* private mode: keep it in memory */
  }
  if (s.theme !== prev.theme || s.density !== prev.density || s.motion !== prev.motion || s.textSize !== prev.textSize) applyTheme();
});

export function resolvedTheme(): 'dark' | 'light' {
  return resolve(useUi.getState().theme);
}

/** Write the appearance to <html>. The wave engine and logos follow it. */
export function applyTheme() {
  const root = document.documentElement;
  const s = useUi.getState();
  const t = resolve(s.theme);
  root.dataset.theme = t;
  if (s.density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
  if (s.motion === 'reduce') root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  // the conversation's text (index.css .log-text): a variable, so it changes live
  applyTextSize(root, s.textSize);
  root.style.removeProperty('--accent-h');
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  meta?.setAttribute('content', t === 'light' ? '#f9f9fa' : '#141417');
  if (s.resolved !== t) useUi.setState({ resolved: t });
}

media?.addEventListener('change', () => {
  if (useUi.getState().theme === 'system') applyTheme();
});

export function toggleTheme() {
  const s = useUi.getState();
  s.set({ theme: resolve(s.theme) === 'dark' ? 'light' : 'dark' });
}

export function openPalette(mode: UiState['paletteMode'] = 'root', query?: string) {
  useUi.setState({ paletteOpen: true, paletteMode: mode, paletteQuery: query });
}

export function closePalette() {
  useUi.setState({ paletteOpen: false, paletteQuery: undefined });
}

/** Toggle the context panel: docked on wide screens, a drawer elsewhere. */
export function toggleContext() {
  const s = useUi.getState();
  if (window.matchMedia('(min-width: 1280px)').matches) s.set({ contextOpen: !s.contextOpen });
  else s.set({ drawerOpen: !s.drawerOpen });
}

export function openNewChat(preset?: UiState['newChatPreset']) {
  useUi.setState({ newChatOpen: true, newChatPreset: preset });
}

export function openShortcuts() {
  useUi.setState({ shortcutsOpen: true });
}

/** Fold a sidebar group shut, or open it again. */
export function toggleFolded(key: string) {
  const s = useUi.getState();
  s.set({ foldedGroups: s.foldedGroups.includes(key) ? s.foldedGroups.filter((k) => k !== key) : [...s.foldedGroups, key] });
}

/** Open or close a card of the session panel; the choice is kept on this device. */
export function setCardOpen(id: string, open: boolean) {
  const s = useUi.getState();
  s.set({ cards: { ...s.cards, [id]: open } });
}
