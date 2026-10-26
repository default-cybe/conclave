/**
 * Motion primitives (docs/design/CHAT-AND-MOTION.md section 1). Transform and
 * opacity only, or canvas, or the Highlight API for text; every one pauses
 * offscreen and draws a still frame under reduced motion. Tokens:
 * styles/motion.css, mirrored in tokens.ts. See them all at /dev/ui#motion.
 */
export { Knot, knotState, type KnotProps, type MarkState } from './Knot';
export { KnotMotion, knotSpan, knotStill, ropeDuration, ropePose, type KnotState, type KnotPose, type RopeMoment, type RopePose } from './knotMath';
// the knot as a rope that ties itself: launch, run, success, receive and send (docs/design/KNOT-MOTION.md)
export { KnotRope, useRopeMoment, type KnotRopeProps } from './KnotRope';
export { InkReveal, useInkReveal, inkSchedule } from './InkReveal';
export { Rim, RimMotion, type RimState, type RimProps } from './Rim';
export { Steps, type Step, type StepsProps } from './Steps';
export { Fold, MorphLabel, type FoldProps } from './Fold';
export { Roll, type RollProps } from './Roll';
export { SendStopButton, SendStopIcon, type SendStopButtonProps } from './SendStop';
export { GapList, GAP_OUT_MS, useGapClose, type GapListProps } from './GapList';
export { CardToPanel, growFrames, type CardToPanelProps } from './CardToPanel';
export { Shimmer, type ShimmerProps } from './Shimmer';
export { Swap } from './Swap';
export { LiveStatus, clockLeft, type LiveState, type LiveStatusProps } from './LiveStatus';
export { Elapsed } from './Elapsed';
export { useReducedMotion, usePageVisible, useOnscreen, useLiveSlot } from './useReducedMotion';
export { usePresence, usePresenceList, useHeld, useArrivals, arrived } from './usePresence';
export { DUR, LOOP, STREAM, SPRING } from './tokens';
// the pet and the agent glyphs (docs/design/CHAT-AND-MOTION.md 1.11)
export { Pet, type PetProps } from './Pet';
export { AgentGlyph, type AgentGlyphProps } from './AgentGlyph';
export { glyphKind, glyphState, petState, sessionPet, busiestKind, stillRows, GLYPH_KINDS, PET_STATES, LIVE_ROWS, type GlyphKind, type GlyphState, type PetState } from './agentGlyphs';
export { EASE, spring, springCss } from './ease';
