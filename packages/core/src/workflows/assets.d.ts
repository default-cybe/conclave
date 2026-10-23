/** The QuickJS wasm file, imported with { type: 'file' } so `bun build --compile` embeds it (workflows/sandbox.ts). */
declare module '@jitl/quickjs-wasmfile-release-sync/wasm' {
  const path: string;
  export default path;
}

/** Default workflow scripts imported as text (workflows/defaults). */
declare module '*.js' {
  const text: string;
  export default text;
}
