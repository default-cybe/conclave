/**
 * Compile the conclave CLI into one binary.
 *
 *   bun scripts/build-cli.ts [--target bun-linux-x64] [--outfile dist/conclave] [--entry daemon] [--windows-hide-console]
 *
 * Used by CI, the release workflow and scripts/build-sidecar.ts (the copy the
 * desktop app carries). --windows-hide-console builds a Windows binary that
 * opens no console window, for the daemon the app starts at sign in.
 * --entry daemon builds conclave-daemon (packages/cli/src/daemon-main.ts)
 * instead of the full CLI. Ink imports react-devtools-core for its
 * optional devtools (only loaded when DEV=true); the package is not installed,
 * so it is replaced with an empty stub here.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    outfile: { type: 'string', default: 'dist/conclave' },
    'windows-hide-console': { type: 'boolean', default: false },
    entry: { type: 'string', default: 'cli' },
  },
});

// fileURLToPath, not .pathname: on Windows that is /D:/... and Bun cannot open it
const root = fileURLToPath(new URL('..', import.meta.url));

const result = await Bun.build({
  entrypoints: [`${root}packages/cli/src/${values.entry === 'daemon' ? 'daemon-bin.ts' : 'bin.ts'}`],
  compile: {
    ...(values.target ? { target: values.target as Bun.Build.CompileTarget } : {}),
    outfile: values.outfile,
    ...(values['windows-hide-console'] ? { windows: { hideConsole: true } } : {}),
  },
  // Browser automation is optional and loaded with a dynamic import at runtime.
  // Keep Playwright and its heavy transitive deps out of the binary; the browser
  // tools light up only when playwright-core is installed next to the binary.
  external: ['playwright-core', 'chromium-bidi', 'electron'],
  plugins: [
    {
      name: 'stub-react-devtools-core',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default { initialize() {}, connectToDevTools() {} };',
          loader: 'js',
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${values.outfile}${values.target ? ` (${values.target})` : ''}`);
