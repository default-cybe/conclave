/**
 * Build conclave-daemon, the binary the desktop app carries, named the way
 * Tauri's externalBin wants it:
 *
 *   packages/desktop/src-tauri/binaries/conclave-daemon-<rust target triple>[.exe]
 *
 * By default it is the Rust daemon (packages/daemon-rs, cargo build
 * --release). `--impl ts` (or CONCLAVE_SIDECAR=ts) builds the TypeScript one
 * instead: packages/cli/src/daemon-main.ts compiled with `bun build
 * --compile`, kept as a fallback. Both follow docs/design/DAEMON-SIDECAR.md.
 *
 *   bun scripts/build-sidecar.ts [--target aarch64-apple-darwin] [--impl rust|ts] [--if-missing]
 *
 * --if-missing keeps the binary there when `<binary>.impl` next to it names
 * the implementation asked for (--impl or CONCLAVE_SIDECAR), or any one when
 * none was asked (the release builds it first, then tauri build runs this).
 * A binary without that file is from before the switch to Rust: it is built
 * again.
 *
 * The target comes from --target, else TAURI_ENV_TARGET_TRIPLE (set by
 * `tauri build`, which runs this as its beforeBuildCommand), else this
 * machine. universal-apple-darwin joins both Mac builds with lipo.
 * TypeScript builds: x64 uses Bun's baseline runtime, so a desktop with an
 * older CPU still runs it, and the Windows build opens no console window
 * (only when built on Windows). The Rust build is a GUI program on Windows
 * by itself.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    impl: { type: 'string' },
    'if-missing': { type: 'boolean', default: false },
  },
});

// fileURLToPath, not .pathname: on Windows that is /D:/... and Bun cannot open it
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = `${root}packages/desktop/src-tauri/binaries`;

const asked = values.impl || process.env.CONCLAVE_SIDECAR;
const impl = asked || 'rust';
if (impl !== 'rust' && impl !== 'ts') {
  console.error(`--impl must be rust or ts, not ${impl}`);
  process.exit(2);
}

/** Rust target triple -> Bun compile target. */
const BUN_TARGETS: Record<string, string> = {
  'x86_64-unknown-linux-gnu': 'bun-linux-x64-baseline',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64-baseline',
};

function hostTriple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

const triple = values.target || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const exe = triple.includes('windows') ? '.exe' : '';
const outfile = `${outDir}/conclave-daemon-${triple}${exe}`;
const implFile = `${outfile}.impl`;

if (values['if-missing'] && existsSync(outfile)) {
  const built = existsSync(implFile) ? readFileSync(implFile, 'utf8').trim() : undefined;
  if (built && (built === impl || !asked)) {
    console.log(`sidecar ${outfile} (${built}) is there (bun scripts/build-sidecar.ts builds it again)`);
    process.exit(0);
  }
  console.log(`sidecar ${outfile} is ${built ? `the ${built} daemon` : 'from an older build'}: building the ${impl} daemon`);
}

async function run(args: string[]): Promise<void> {
  const p = Bun.spawn(args, { stdio: ['inherit', 'inherit', 'inherit'] });
  if ((await p.exited) !== 0) throw new Error(`${args.join(' ')} failed`);
}

async function compileTs(t: string, file: string): Promise<void> {
  const bunTarget = BUN_TARGETS[t];
  if (!bunTarget) throw new Error(`No Bun build for ${t}. Known: ${Object.keys(BUN_TARGETS).join(', ')}, universal-apple-darwin`);
  const args = ['bun', `${root}scripts/build-cli.ts`, '--entry', 'daemon', '--target', bunTarget, '--outfile', file];
  if (bunTarget.startsWith('bun-windows') && process.platform === 'win32') args.push('--windows-hide-console');
  await run(args);
}

/** cargo build --release for one target, then the binary copied into place. */
async function compileRust(t: string, file: string): Promise<void> {
  if (!Bun.which('cargo')) throw new Error('cargo is not on PATH. Install Rust (https://rustup.rs), or build the TypeScript daemon with --impl ts.');
  const crate = `${root}packages/daemon-rs`;
  await run(['cargo', 'build', '--release', '--locked', '--manifest-path', `${crate}/Cargo.toml`, '--target', t]);
  const targetDir = process.env.CARGO_TARGET_DIR || `${crate}/target`;
  copyFileSync(`${targetDir}/${t}/release/conclave-daemon${t.includes('windows') ? '.exe' : ''}`, file);
}

const compile = impl === 'rust' ? compileRust : compileTs;

mkdirSync(outDir, { recursive: true });
rmSync(implFile, { force: true });
if (triple === 'universal-apple-darwin') {
  const parts = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map((t) => ({ t, file: `${outDir}/conclave-daemon-${t}` }));
  for (const { t, file } of parts) await compile(t, file);
  const lipo = Bun.spawn(['lipo', '-create', '-output', outfile, ...parts.map((x) => x.file)], { stdio: ['inherit', 'inherit', 'inherit'] });
  if ((await lipo.exited) !== 0) throw new Error('lipo failed (it runs on macOS only)');
  for (const { file } of parts) rmSync(file, { force: true });
} else {
  try {
    await compile(triple, outfile);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
writeFileSync(implFile, `${impl}\n`);
console.log(`sidecar ${outfile} (${impl}, ${Math.round(statSync(outfile).size / 1e5) / 10} MB)`);
