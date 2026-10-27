// Fixture for scripts/check-styles.test.ts: none of these break a rule.
/* A comment may say uppercase, gradient, #fff, ★ and Sparkline. */
export const Dot = () => <span className="size-2 rounded-full bg-ok" />;
export const Round = () => <button className="h-11 rounded-full px-2.5 text-fg-2 active:bg-hover">Deny</button>;
export const Ring = () => <div className="shadow-[0_0_0_1px_var(--rule)]" />;
export const Fade = () => <div className="[mask-image:linear-gradient(to_bottom,black,transparent)]" />;
export const Glob = () => <code>{'src/**/*.tsx'}</code>;
export const Anchor = () => <a href="#top">Top</a>;
