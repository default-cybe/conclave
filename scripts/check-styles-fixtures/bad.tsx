// Fixture for scripts/check-styles.test.ts: one banned style per line, line numbers matter.
export const Pill = () => <span className="rounded-full bg-raise px-2 text-fg-3">tag</span>;
export const Upper = () => <span className="text-[11px] uppercase tracking-wide">label</span>;
export const Gradient = () => <div className="bg-gradient-to-r from-signal to-ok" />;
export const Glass = () => <div className="backdrop-blur-md" />;
export const Glow = () => <div className="shadow-[0_0_12px_var(--signal)]" />;
export const Spinner = () => <div className="animate-spin" />;
export const Glyph = () => <span>★ Starred</span>;
export const Hex = () => <div style={{ color: '#ff00aa' }} />;
export const Spark = () => <Sparkline />;
export const masked = <div style={{ background: 'linear-gradient(red, blue)', color: '#ff00ab' }} />;
export const Slash = () => <a title="a // b" className="uppercase" />;
export const GlowStyle = () => <div style={{ boxShadow: '0 0 12px var(--signal)' }} />;
