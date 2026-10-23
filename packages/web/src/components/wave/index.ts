/**
 * The dot wave: brand art only (docs/design/MOTION.md 3.5). The still logo,
 * the onboarding, Connect and Done hero, and the empty-state band. Live work
 * is never drawn with dots: it is the Knot, the Rim and Ink (components/motion).
 */
export { Wave, type WaveProps } from './Wave';
export { mountWave, motionReduced, rateFromTps, WAVE_DEFAULTS, type WaveHandle, type WaveOptions, type WaveTone, type WaveVariant } from './engine';
