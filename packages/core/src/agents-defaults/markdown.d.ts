/**
 * Markdown files imported as text, e.g.
 *   import base from './BASE.md' with { type: 'text' };
 * Bun embeds the file contents, so the compiled binary needs no files on disk.
 */
declare module '*.md' {
  const text: string;
  export default text;
}
