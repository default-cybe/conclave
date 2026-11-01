# Third-party notices

Conclave is licensed under AGPL-3.0-only (see [LICENSE](LICENSE)). It includes or depends on the third-party software listed below, each under its own license. This file lists name, version, license and project URL; the full license texts ship with each package (in its npm package, crate or Maven artifact) or are linked here.

Generated on 2026-10-23 from `bun.lock`, the installed `package.json` license fields, `packages/daemon-rs/Cargo.lock`, `packages/desktop/src-tauri/Cargo.lock` and `packages/android/gradle/libs.versions.toml`. Regenerate it when dependencies change.

## Notes

- **CLIProxyAPI** (https://github.com/router-for-me/CLIProxyAPI, MIT) is not bundled. The hub downloads it at runtime only when subscription sign-in is enabled.
- **MPL-2.0 dependencies**: `ical.js` and `web-push` are under the Mozilla Public License 2.0. Their source is available at the URLs below; changes to those files would have to stay under MPL-2.0.
- **Google ML Kit** (`com.google.mlkit:barcode-scanning`, Android app, used for QR pairing) is proprietary and covered by the ML Kit Terms of Service (https://developers.google.com/ml-kit/terms), not by an open source license.
- Rust lists come from the lock files and include every crate the lock resolves, across all target platforms; a given build links a subset. Licenses for crates were not available offline and are marked "see crate": check the crate page.
- Android licenses are from the maintainers' published documentation, not read from the artifacts, and are marked as such. Transitive Maven dependencies are not listed.

## Bundled attribution files

These files ship in the Android app (`packages/android/app/src/main/assets/licenses/`) and hold the full license text:

- [lobehub-icons-MIT.txt](packages/android/app/src/main/assets/licenses/lobehub-icons-MIT.txt): LobeHub icons (MIT). The same icons ship in the web app through `@lobehub/icons-static-svg`.
- [mona-sans-OFL.txt](packages/android/app/src/main/assets/licenses/mona-sans-OFL.txt): Mona Sans (SIL Open Font License 1.1).
- [jetbrains-mono-OFL.txt](packages/android/app/src/main/assets/licenses/jetbrains-mono-OFL.txt): JetBrains Mono (SIL Open Font License 1.1).

## Fonts

| Font | License | URL | Shipped in |
|---|---|---|---|
| Mona Sans | OFL-1.1 | https://github.com/github/mona-sans | web (via `@fontsource-variable/mona-sans`), desktop (`packages/desktop/src/fonts/`), Android (`res/font/`), site |
| JetBrains Mono | OFL-1.1 | https://github.com/JetBrains/JetBrainsMono | web (via `@fontsource-variable/jetbrains-mono`), desktop (`packages/desktop/src/fonts/`), Android (`res/font/`) |

## npm packages (326)

Production dependencies, direct and transitive, of the hub (`packages/core`, `packages/server`), CLI (`packages/cli`), web app (`packages/web`) and mobile shell (`packages/mobile`). Dev and build tools are not listed.

| Package | Version | License | URL | Used by |
|---|---|---|---|---|
| @agentclientprotocol/sdk | 1.8.0 | Apache-2.0 | https://github.com/agentclientprotocol/typescript-sdk | hub |
| @alcalzone/ansi-tokenize | 0.3.1 | MIT | https://github.com/AlCalzone/ansi-tokenize | cli |
| @capacitor/android | 8.5.3 | MIT | https://github.com/ionic-team/capacitor | mobile |
| @capacitor/core | 8.5.3 | MIT | https://github.com/ionic-team/capacitor | mobile |
| @capacitor/ios | 8.5.3 | MIT | https://github.com/ionic-team/capacitor | mobile |
| @fontsource-variable/jetbrains-mono | 5.3.0 | OFL-1.1 | https://github.com/fontsource/font-files | web |
| @fontsource-variable/mona-sans | 5.3.0 | OFL-1.1 | https://github.com/fontsource/font-files | web |
| @hono/node-server | 2.1.5 | MIT | https://github.com/honojs/node-server | hub |
| @jitl/quickjs-ffi-types | 0.31.0 | MIT | https://github.com/justjake/quickjs-emscripten | hub |
| @jitl/quickjs-wasmfile-release-sync | 0.31.0 | MIT | https://github.com/justjake/quickjs-emscripten | hub |
| @lobehub/icons-static-svg | 1.95.1 | MIT | https://github.com/lobehub/lobe-icons | web |
| @mixmark-io/domino | 2.2.0 | BSD-2-Clause | https://github.com/mixmark-io/domino | hub |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | https://github.com/modelcontextprotocol/typescript-sdk | hub |
| @mozilla/readability | 0.6.0 | Apache-2.0 | https://github.com/mozilla/readability | hub |
| @types/debug | 4.1.13 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/estree | 1.0.9 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/estree-jsx | 1.0.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/hast | 3.0.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/mdast | 4.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/ms | 2.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/react | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/unist | 2.0.11 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @types/unist | 3.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped | web |
| @ungap/structured-clone | 1.4.0 | ISC | https://github.com/ungap/structured-clone | web |
| accepts | 2.0.0 | MIT | https://github.com/jshttp/accepts | hub |
| agent-base | 7.1.4 | MIT | https://github.com/TooTallNate/proxy-agents | hub |
| ajv | 8.20.0 | MIT | https://github.com/ajv-validator/ajv | hub |
| ajv-formats | 3.0.1 | MIT | https://github.com/ajv-validator/ajv-formats | hub |
| ansi-escapes | 7.3.0 | MIT | https://github.com/sindresorhus/ansi-escapes | cli |
| ansi-regex | 5.0.1 | MIT | https://github.com/chalk/ansi-regex | cli, hub |
| ansi-regex | 6.4.0 | MIT | https://github.com/chalk/ansi-regex | cli |
| ansi-styles | 4.3.0 | MIT | https://github.com/chalk/ansi-styles | cli, hub |
| ansi-styles | 6.2.3 | MIT | https://github.com/chalk/ansi-styles | cli |
| ansi-styles | 7.0.0 | MIT | https://github.com/chalk/ansi-styles | cli |
| asn1.js | 5.4.1 | MIT | https://github.com/indutny/asn1.js | hub |
| auto-bind | 5.0.1 | MIT | https://github.com/sindresorhus/auto-bind | cli |
| bail | 2.0.2 | MIT | https://github.com/wooorm/bail | web |
| bn.js | 4.12.5 | MIT | https://github.com/indutny/bn.js | hub |
| body-parser | 2.3.0 | MIT | https://github.com/expressjs/body-parser | hub |
| boolbase | 2.0.0 | ISC | https://github.com/fb55/boolbase | hub |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | https://github.com/goinstant/buffer-equal-constant-time | hub |
| bytes | 3.1.2 | MIT | https://github.com/visionmedia/bytes.js | hub |
| call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers | hub |
| call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound | hub |
| camelcase | 5.3.1 | MIT | https://github.com/sindresorhus/camelcase | cli, hub |
| ccount | 2.0.1 | MIT | https://github.com/wooorm/ccount | web |
| chalk | 5.6.2 | MIT | https://github.com/chalk/chalk | cli |
| chalk | 6.0.1 | MIT | https://github.com/chalk/chalk | cli |
| character-entities | 2.0.2 | MIT | https://github.com/wooorm/character-entities | web |
| character-entities-html4 | 2.1.0 | MIT | https://github.com/wooorm/character-entities-html4 | web |
| character-entities-legacy | 3.0.0 | MIT | https://github.com/wooorm/character-entities-legacy | web |
| character-reference-invalid | 2.0.1 | MIT | https://github.com/wooorm/character-reference-invalid | web |
| cli-boxes | 4.0.1 | MIT | https://github.com/sindresorhus/cli-boxes | cli |
| cli-cursor | 4.0.0 | MIT | https://github.com/sindresorhus/cli-cursor | cli |
| cli-truncate | 6.1.1 | MIT | https://github.com/sindresorhus/cli-truncate | cli |
| cliui | 6.0.0 | ISC | https://github.com/yargs/cliui | cli, hub |
| clsx | 2.1.1 | MIT | https://github.com/lukeed/clsx | web |
| code-excerpt | 4.0.0 | MIT | https://github.com/vadimdemedes/code-excerpt | cli |
| color-convert | 2.0.1 | MIT | https://github.com/Qix-/color-convert | cli, hub |
| color-name | 1.1.4 | MIT | https://github.com/colorjs/color-name | cli, hub |
| comma-separated-tokens | 2.0.3 | MIT | https://github.com/wooorm/comma-separated-tokens | web |
| content-disposition | 2.0.1 | MIT | https://github.com/jshttp/content-disposition | hub |
| content-type | 1.0.5 | MIT | https://github.com/jshttp/content-type | hub |
| content-type | 2.1.0 | MIT | https://github.com/jshttp/content-type | hub |
| convert-to-spaces | 2.0.1 | MIT | https://github.com/vadimdemedes/convert-to-spaces | cli |
| cookie | 0.7.2 | MIT | https://github.com/jshttp/cookie | hub |
| cookie-signature | 1.2.2 | MIT | https://github.com/visionmedia/node-cookie-signature | hub |
| cors | 2.8.6 | MIT | https://github.com/expressjs/cors | hub |
| croner | 10.0.1 | MIT | https://github.com/hexagon/croner | hub |
| cross-spawn | 7.0.6 | MIT | https://github.com/moxystudio/node-cross-spawn | hub |
| css-select | 7.0.0 | BSD-2-Clause | https://github.com/fb55/css-select | hub |
| css-what | 8.0.0 | BSD-2-Clause | https://github.com/fb55/css-what | hub |
| cssom | 0.5.0 | MIT | https://github.com/NV/CSSOM | hub |
| csstype | 3.2.3 | MIT | https://github.com/frenic/csstype | web |
| debug | 4.4.3 | MIT | https://github.com/debug-js/debug | hub, web |
| decamelize | 1.2.0 | MIT | https://github.com/sindresorhus/decamelize | cli, hub |
| decode-named-character-reference | 1.3.0 | MIT | https://github.com/wooorm/decode-named-character-reference | web |
| depd | 2.0.0 | MIT | https://github.com/dougwilson/nodejs-depd | hub |
| dequal | 2.0.3 | MIT | https://github.com/lukeed/dequal | web |
| devlop | 1.1.0 | MIT | https://github.com/wooorm/devlop | web |
| diff | 9.0.0 | BSD-3-Clause | https://github.com/kpdecker/jsdiff | hub |
| dijkstrajs | 1.0.3 | MIT | https://github.com/tcort/dijkstrajs | cli, hub |
| dom-serializer | 2.0.0 | MIT | https://github.com/cheeriojs/dom-serializer | hub |
| dom-serializer | 3.1.1 | MIT | https://github.com/cheeriojs/dom-serializer | hub |
| domelementtype | 2.3.0 | BSD-2-Clause | https://github.com/fb55/domelementtype | hub |
| domelementtype | 3.0.0 | BSD-2-Clause | https://github.com/fb55/domelementtype | hub |
| domhandler | 5.0.3 | BSD-2-Clause | https://github.com/fb55/domhandler | hub |
| domhandler | 6.0.1 | BSD-2-Clause | https://github.com/fb55/domhandler | hub |
| domutils | 3.2.2 | BSD-2-Clause | https://github.com/fb55/domutils | hub |
| domutils | 4.0.2 | BSD-2-Clause | https://github.com/fb55/domutils | hub |
| dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto | hub |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | https://github.com/Brightspace/node-ecdsa-sig-formatter | hub |
| ee-first | 1.1.1 | MIT | https://github.com/jonathanong/ee-first | hub |
| emoji-regex | 8.0.0 | MIT | https://github.com/mathiasbynens/emoji-regex | cli, hub |
| encodeurl | 2.0.0 | MIT | https://github.com/pillarjs/encodeurl | hub |
| entities | 4.5.0 | BSD-2-Clause | https://github.com/fb55/entities | hub |
| entities | 7.0.1 | BSD-2-Clause | https://github.com/fb55/entities | hub |
| entities | 8.1.0 | BSD-2-Clause | https://github.com/fb55/entities | hub |
| environment | 1.1.0 | MIT | https://github.com/sindresorhus/environment | cli |
| es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property | hub |
| es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors | hub |
| es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms | hub |
| es-toolkit | 1.52.0 | MIT | https://github.com/toss/es-toolkit | cli |
| escape-html | 1.0.3 | MIT | https://github.com/component/escape-html | hub |
| escape-string-regexp | 2.0.0 | MIT | https://github.com/sindresorhus/escape-string-regexp | cli |
| escape-string-regexp | 5.0.0 | MIT | https://github.com/sindresorhus/escape-string-regexp | web |
| estree-util-is-identifier-name | 3.0.0 | MIT | https://github.com/syntax-tree/estree-util-is-identifier-name | web |
| etag | 1.8.1 | MIT | https://github.com/jshttp/etag | hub |
| eventsource | 3.0.7 | MIT | https://git@github.com/EventSource/eventsource | hub |
| eventsource-parser | 3.1.1 | MIT | https://github.com/rexxars/eventsource-parser | hub |
| express | 5.3.0 | MIT | https://github.com/expressjs/express | hub |
| express-rate-limit | 8.7.1 | MIT | https://github.com/express-rate-limit/express-rate-limit | hub |
| extend | 3.0.2 | MIT | https://github.com/justmoon/node-extend | web |
| fast-deep-equal | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal | hub |
| fast-uri | 3.1.8 | BSD-3-Clause | https://github.com/fastify/fast-uri | hub |
| finalhandler | 2.1.1 | MIT | https://github.com/pillarjs/finalhandler | hub |
| find-up | 4.1.0 | MIT | https://github.com/sindresorhus/find-up | cli, hub |
| forwarded | 0.2.0 | MIT | https://github.com/jshttp/forwarded | hub |
| fresh | 2.0.0 | MIT | https://github.com/jshttp/fresh | hub |
| function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind | hub |
| get-caller-file | 2.0.5 | ISC | https://github.com/stefanpenner/get-caller-file | cli, hub |
| get-east-asian-width | 1.7.0 | MIT | https://github.com/sindresorhus/get-east-asian-width | cli |
| get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic | hub |
| get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto | hub |
| gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd | hub |
| has-symbols | 1.1.0 | MIT | https://github.com/inspect-js/has-symbols | hub |
| hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn | hub |
| hast-util-to-jsx-runtime | 2.3.6 | MIT | https://github.com/syntax-tree/hast-util-to-jsx-runtime | web |
| hast-util-whitespace | 3.0.0 | MIT | https://github.com/syntax-tree/hast-util-whitespace | web |
| highlight.js | 11.12.0 | BSD-3-Clause | https://github.com/highlightjs/highlight.js | web |
| hono | 4.13.13 | MIT | https://github.com/honojs/hono | hub |
| html-escaper | 3.0.3 | MIT | https://github.com/WebReflection/html-escaper | hub |
| html-url-attributes | 3.0.1 | MIT | https://github.com/rehypejs/rehype-minify/tree/main/packages/html-url-attributes | web |
| htmlparser2 | 10.1.0 | MIT | https://github.com/fb55/htmlparser2 | hub |
| http_ece | 1.2.0 | MIT | https://github.com/martinthomson/encrypted-content-encoding | hub |
| http-errors | 2.0.1 | MIT | https://github.com/jshttp/http-errors | hub |
| https-proxy-agent | 7.0.6 | MIT | https://github.com/TooTallNate/proxy-agents | hub |
| ical.js | 2.2.1 | MPL-2.0 | https://github.com/kewisch/ical.js | hub |
| iconv-lite | 0.7.3 | MIT | https://github.com/pillarjs/iconv-lite | hub |
| indent-string | 5.0.0 | MIT | https://github.com/sindresorhus/indent-string | cli |
| inherits | 2.0.4 | ISC | https://github.com/isaacs/inherits | hub |
| ink | 8.0.0 | MIT | https://github.com/vadimdemedes/ink | cli |
| ink-text-input | 6.0.0 | MIT | https://github.com/vadimdemedes/ink-text-input | cli |
| inline-style-parser | 0.2.7 | MIT | https://github.com/remarkablemark/inline-style-parser | web |
| ip-address | 10.7.4 | MIT | https://github.com/beaugunderson/ip-address | hub |
| ipaddr.js | 1.9.1 | MIT | https://github.com/whitequark/ipaddr.js | hub |
| is-alphabetical | 2.0.1 | MIT | https://github.com/wooorm/is-alphabetical | web |
| is-alphanumerical | 2.0.1 | MIT | https://github.com/wooorm/is-alphanumerical | web |
| is-decimal | 2.0.1 | MIT | https://github.com/wooorm/is-decimal | web |
| is-fullwidth-code-point | 3.0.0 | MIT | https://github.com/sindresorhus/is-fullwidth-code-point | cli, hub |
| is-fullwidth-code-point | 5.1.0 | MIT | https://github.com/sindresorhus/is-fullwidth-code-point | cli |
| is-hexadecimal | 2.0.1 | MIT | https://github.com/wooorm/is-hexadecimal | web |
| is-in-ci | 2.0.0 | MIT | https://github.com/sindresorhus/is-in-ci | cli |
| is-plain-obj | 4.1.0 | MIT | https://github.com/sindresorhus/is-plain-obj | web |
| is-promise | 4.0.0 | MIT | https://github.com/then/is-promise | hub |
| isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe | hub |
| jose | 6.2.12 | MIT | https://github.com/panva/jose | hub |
| json-schema-traverse | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse | hub |
| json-schema-typed | 8.0.2 | BSD-2-Clause | https://github.com/RemyRylan/json-schema-typed | hub |
| jsqr | 1.4.0 | Apache-2.0 | https://github.com/cozmo/jsQR | web |
| jwa | 2.0.1 | MIT | https://github.com/brianloveswords/node-jwa | hub |
| jws | 4.0.1 | MIT | https://github.com/brianloveswords/node-jws | hub |
| linkedom | 0.18.13 | ISC | https://github.com/WebReflection/linkedom | hub |
| locate-path | 5.0.0 | MIT | https://github.com/sindresorhus/locate-path | cli, hub |
| longest-streak | 3.1.0 | MIT | https://github.com/wooorm/longest-streak | web |
| lucide-react | 1.58.0 | ISC | https://github.com/lucide-icons/lucide | web |
| markdown-table | 3.0.4 | MIT | https://github.com/wooorm/markdown-table | web |
| math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics | hub |
| mdast-util-find-and-replace | 3.0.3 | MIT | https://github.com/syntax-tree/mdast-util-find-and-replace | web |
| mdast-util-from-markdown | 2.1.0 | MIT | https://github.com/syntax-tree/mdast-util-from-markdown | web |
| mdast-util-gfm | 3.1.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm | web |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT | https://github.com/syntax-tree/mdast-util-gfm-autolink-literal | web |
| mdast-util-gfm-footnote | 2.1.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm-footnote | web |
| mdast-util-gfm-strikethrough | 2.0.1 | MIT | https://github.com/syntax-tree/mdast-util-gfm-strikethrough | web |
| mdast-util-gfm-table | 2.0.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm-table | web |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm-task-list-item | web |
| mdast-util-mdx-expression | 2.0.1 | MIT | https://github.com/syntax-tree/mdast-util-mdx-expression | web |
| mdast-util-mdx-jsx | 3.2.0 | MIT | https://github.com/syntax-tree/mdast-util-mdx-jsx | web |
| mdast-util-mdxjs-esm | 2.0.1 | MIT | https://github.com/syntax-tree/mdast-util-mdxjs-esm | web |
| mdast-util-phrasing | 4.1.0 | MIT | https://github.com/syntax-tree/mdast-util-phrasing | web |
| mdast-util-to-hast | 13.2.1 | MIT | https://github.com/syntax-tree/mdast-util-to-hast | web |
| mdast-util-to-markdown | 2.2.0 | MIT | https://github.com/syntax-tree/mdast-util-to-markdown | web |
| mdast-util-to-string | 4.0.0 | MIT | https://github.com/syntax-tree/mdast-util-to-string | web |
| media-typer | 1.1.1 | MIT | https://github.com/jshttp/media-typer | hub |
| merge-descriptors | 2.0.0 | MIT | https://github.com/sindresorhus/merge-descriptors | hub |
| micromark | 4.0.3 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark | web |
| micromark-core-commonmark | 2.0.4 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark | web |
| micromark-extension-gfm | 3.0.0 | MIT | https://github.com/micromark/micromark-extension-gfm | web |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-autolink-literal | web |
| micromark-extension-gfm-footnote | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-footnote | web |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-strikethrough | web |
| micromark-extension-gfm-table | 2.1.2 | MIT | https://github.com/micromark/micromark-extension-gfm-table | web |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT | https://github.com/micromark/micromark-extension-gfm-tagfilter | web |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-task-list-item | web |
| micromark-factory-destination | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination | web |
| micromark-factory-label | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label | web |
| micromark-factory-space | 2.1.0 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space | web |
| micromark-factory-title | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title | web |
| micromark-factory-whitespace | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace | web |
| micromark-util-character | 2.1.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-character | web |
| micromark-util-chunked | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked | web |
| micromark-util-classify-character | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character | web |
| micromark-util-combine-extensions | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions | web |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference | web |
| micromark-util-decode-string | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string | web |
| micromark-util-edit-map | 1.0.0 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-edit-map | web |
| micromark-util-encode | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode | web |
| micromark-util-html-tag-name | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name | web |
| micromark-util-normalize-identifier | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier | web |
| micromark-util-resolve-all | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all | web |
| micromark-util-sanitize-uri | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri | web |
| micromark-util-subtokenize | 2.1.0 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize | web |
| micromark-util-symbol | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol | web |
| micromark-util-types | 2.0.3 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-types | web |
| mime-db | 1.54.0 | MIT | https://github.com/jshttp/mime-db | hub |
| mime-types | 3.0.2 | MIT | https://github.com/jshttp/mime-types | hub |
| mimic-fn | 2.1.0 | MIT | https://github.com/sindresorhus/mimic-fn | cli |
| minimalistic-assert | 1.0.1 | ISC | https://github.com/calvinmetcalf/minimalistic-assert | hub |
| minimist | 1.2.8 | MIT | https://github.com/minimistjs/minimist | hub |
| ms | 2.1.3 | MIT | https://github.com/vercel/ms | hub, web |
| negotiator | 1.1.0 | MIT | https://github.com/jshttp/negotiator | hub |
| nth-check | 3.0.1 | BSD-2-Clause | https://github.com/fb55/nth-check | hub |
| object-assign | 4.1.1 | MIT | https://github.com/sindresorhus/object-assign | hub |
| object-inspect | 1.13.4 | MIT | https://github.com/inspect-js/object-inspect | hub |
| on-finished | 2.4.1 | MIT | https://github.com/jshttp/on-finished | hub |
| once | 1.4.0 | ISC | https://github.com/isaacs/once | hub |
| onetime | 5.1.2 | MIT | https://github.com/sindresorhus/onetime | cli |
| p-limit | 2.3.0 | MIT | https://github.com/sindresorhus/p-limit | cli, hub |
| p-locate | 4.1.0 | MIT | https://github.com/sindresorhus/p-locate | cli, hub |
| p-try | 2.2.0 | MIT | https://github.com/sindresorhus/p-try | cli, hub |
| parse-entities | 4.0.2 | MIT | https://github.com/wooorm/parse-entities | web |
| parseurl | 1.3.3 | MIT | https://github.com/pillarjs/parseurl | hub |
| patch-console | 2.0.0 | MIT | https://github.com/vadimdemedes/patch-console | cli |
| path-exists | 4.0.0 | MIT | https://github.com/sindresorhus/path-exists | cli, hub |
| path-key | 3.1.1 | MIT | https://github.com/sindresorhus/path-key | hub |
| path-to-regexp | 8.4.2 | MIT | https://github.com/pillarjs/path-to-regexp | hub |
| pkce-challenge | 5.0.1 | MIT | https://github.com/crouchcd/pkce-challenge | hub |
| playwright-core | 1.64.1 | Apache-2.0 | https://github.com/microsoft/playwright | hub |
| pngjs | 5.0.0 | MIT | https://github.com/lukeapage/pngjs | cli, hub |
| postal-mime | 4.0.11 | MIT-0 | https://github.com/postalsys/postal-mime | hub |
| property-information | 7.2.0 | MIT | https://github.com/wooorm/property-information | web |
| proxy-addr | 2.0.8 | MIT | https://github.com/jshttp/proxy-addr | hub |
| qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode | cli, hub |
| qs | 6.16.1 | BSD-3-Clause | https://github.com/ljharb/qs | hub |
| quick-lru | 7.3.0 | MIT | https://github.com/sindresorhus/quick-lru | cli |
| quickjs-emscripten-core | 0.31.0 | MIT | https://github.com/justjake/quickjs-emscripten | hub |
| range-parser | 1.3.0 | MIT | https://github.com/jshttp/range-parser | hub |
| raw-body | 3.0.2 | MIT | https://github.com/stream-utils/raw-body | hub |
| react | 19.3.1 | MIT | https://github.com/react/react | cli, web |
| react-dom | 19.3.1 | MIT | https://github.com/react/react | web |
| react-markdown | 10.1.0 | MIT | https://github.com/remarkjs/react-markdown | web |
| react-reconciler | 0.34.0 | MIT | https://github.com/react/react | cli |
| regexparam | 3.0.0 | MIT | https://github.com/lukeed/regexparam | web |
| remark-gfm | 4.0.1 | MIT | https://github.com/remarkjs/remark-gfm | web |
| remark-parse | 11.0.0 | MIT | https://github.com/remarkjs/remark/tree/main/packages/remark-parse | web |
| remark-rehype | 11.1.2 | MIT | https://github.com/remarkjs/remark-rehype | web |
| remark-stringify | 11.0.0 | MIT | https://github.com/remarkjs/remark/tree/main/packages/remark-stringify | web |
| require-directory | 2.1.1 | MIT | https://github.com/troygoode/node-require-directory | cli, hub |
| require-from-string | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string | hub |
| require-main-filename | 2.0.0 | ISC | https://github.com/yargs/require-main-filename | cli, hub |
| restore-cursor | 4.0.0 | MIT | https://github.com/sindresorhus/restore-cursor | cli |
| router | 2.2.0 | MIT | https://github.com/pillarjs/router | hub |
| safe-buffer | 5.2.1 | MIT | https://github.com/feross/safe-buffer | hub |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer | hub |
| scheduler | 0.28.0 | MIT | https://github.com/react/react | cli, web |
| send | 1.2.1 | MIT | https://github.com/pillarjs/send | hub |
| serve-static | 2.2.1 | MIT | https://github.com/expressjs/serve-static | hub |
| set-blocking | 2.0.0 | ISC | https://github.com/yargs/set-blocking | cli, hub |
| setprototypeof | 1.2.0 | ISC | https://github.com/wesleytodd/setprototypeof | hub |
| shebang-command | 2.0.0 | MIT | https://github.com/kevva/shebang-command | hub |
| shebang-regex | 3.0.0 | MIT | https://github.com/sindresorhus/shebang-regex | hub |
| side-channel | 1.1.1 | MIT | https://github.com/ljharb/side-channel | hub |
| side-channel-list | 1.0.1 | MIT | https://github.com/ljharb/side-channel-list | hub |
| side-channel-map | 1.0.1 | MIT | https://github.com/ljharb/side-channel-map | hub |
| side-channel-weakmap | 1.0.2 | MIT | https://github.com/ljharb/side-channel-weakmap | hub |
| signal-exit | 3.0.7 | ISC | https://github.com/tapjs/signal-exit | cli |
| slice-ansi | 9.0.1 | MIT | https://github.com/chalk/slice-ansi | cli |
| space-separated-tokens | 2.0.2 | MIT | https://github.com/wooorm/space-separated-tokens | web |
| stack-utils | 2.0.6 | MIT | https://github.com/tapjs/stack-utils | cli |
| statuses | 2.0.2 | MIT | https://github.com/jshttp/statuses | hub |
| string-width | 4.2.3 | MIT | https://github.com/sindresorhus/string-width | cli, hub |
| string-width | 8.3.0 | MIT | https://github.com/sindresorhus/string-width | cli |
| stringify-entities | 4.0.4 | MIT | https://github.com/wooorm/stringify-entities | web |
| strip-ansi | 6.0.1 | MIT | https://github.com/chalk/strip-ansi | cli, hub |
| strip-ansi | 7.2.0 | MIT | https://github.com/chalk/strip-ansi | cli |
| style-to-js | 1.1.21 | MIT | https://github.com/remarkablemark/style-to-js | web |
| style-to-object | 1.0.14 | MIT | https://github.com/remarkablemark/style-to-object | web |
| tagged-tag | 1.0.0 | MIT | https://github.com/sindresorhus/tagged-tag | cli |
| terminal-size | 4.0.1 | MIT | https://github.com/sindresorhus/terminal-size | cli |
| toidentifier | 1.0.1 | MIT | https://github.com/component/toidentifier | hub |
| trim-lines | 3.0.1 | MIT | https://github.com/wooorm/trim-lines | web |
| trough | 2.2.0 | MIT | https://github.com/wooorm/trough | web |
| tslib | 2.8.1 | 0BSD | https://github.com/Microsoft/tslib | mobile |
| turndown | 7.2.4 | MIT | https://github.com/mixmark-io/turndown | hub |
| type-fest | 4.41.0 | (MIT OR CC0-1.0) | https://github.com/sindresorhus/type-fest | cli |
| type-fest | 5.10.0 | (MIT OR CC0-1.0) | https://github.com/sindresorhus/type-fest | cli |
| type-is | 2.1.0 | MIT | https://github.com/jshttp/type-is | hub |
| uhyphen | 0.2.0 | ISC | https://github.com/WebReflection/uhyphen | hub |
| unified | 11.0.5 | MIT | https://github.com/unifiedjs/unified | web |
| unist-util-is | 6.0.1 | MIT | https://github.com/syntax-tree/unist-util-is | web |
| unist-util-position | 5.0.0 | MIT | https://github.com/syntax-tree/unist-util-position | web |
| unist-util-stringify-position | 4.0.0 | MIT | https://github.com/syntax-tree/unist-util-stringify-position | web |
| unist-util-visit | 5.1.0 | MIT | https://github.com/syntax-tree/unist-util-visit | web |
| unist-util-visit-parents | 6.0.2 | MIT | https://github.com/syntax-tree/unist-util-visit-parents | web |
| unpipe | 1.0.0 | MIT | https://github.com/stream-utils/unpipe | hub |
| use-sync-external-store | 1.7.0 | MIT | https://github.com/react/react | web |
| vary | 1.1.2 | MIT | https://github.com/jshttp/vary | hub |
| vfile | 6.0.3 | MIT | https://github.com/vfile/vfile | web |
| vfile-message | 4.0.3 | MIT | https://github.com/vfile/vfile-message | web |
| web-push | 3.6.7 | MPL-2.0 | https://github.com/web-push-libs/web-push | hub |
| which | 2.0.2 | ISC | https://github.com/isaacs/node-which | hub |
| which-module | 2.0.1 | ISC | https://github.com/nexdrew/which-module | cli, hub |
| widest-line | 6.0.0 | MIT | https://github.com/sindresorhus/widest-line | cli |
| wouter | 3.13.0 | Unlicense | https://github.com/molefrog/wouter | web |
| wrap-ansi | 10.0.2 | MIT | https://github.com/chalk/wrap-ansi | cli |
| wrap-ansi | 6.2.0 | MIT | https://github.com/chalk/wrap-ansi | cli, hub |
| wrappy | 1.0.2 | ISC | https://github.com/npm/wrappy | hub |
| y18n | 4.0.3 | ISC | https://github.com/yargs/y18n | cli, hub |
| yaml | 2.9.1 | ISC | https://github.com/eemeli/yaml | hub |
| yargs | 15.4.1 | MIT | https://github.com/yargs/yargs | cli, hub |
| yargs-parser | 18.1.3 | ISC | https://github.com/yargs/yargs-parser | cli, hub |
| yoga-layout | 3.2.1 | MIT | https://github.com/facebook/yoga | cli |
| zod | 4.6.7 | MIT | https://github.com/colinhacks/zod | hub |
| zod-to-json-schema | 3.25.2 | ISC | https://github.com/StefanTerdell/zod-to-json-schema | hub |
| zustand | 5.0.15 | MIT | https://github.com/pmndrs/zustand | web |
| zwitch | 2.0.4 | MIT | https://github.com/wooorm/zwitch | web |

## Rust crates (562)

From `packages/daemon-rs/Cargo.lock` (daemon) and `packages/desktop/src-tauri/Cargo.lock` (desktop app).

| Crate | Version | License | URL | Used by |
|---|---|---|---|---|
| adler2 | 2.0.1 | see crate | https://crates.io/crates/adler2/2.0.1 | desktop |
| aho-corasick | 1.1.5 | see crate | https://crates.io/crates/aho-corasick/1.1.5 | daemon, desktop |
| alloc-no-stdlib | 3.0.0 | see crate | https://crates.io/crates/alloc-no-stdlib/3.0.0 | desktop |
| alloc-stdlib | 0.3.0 | see crate | https://crates.io/crates/alloc-stdlib/0.3.0 | desktop |
| android_system_properties | 0.1.6 | see crate | https://crates.io/crates/android_system_properties/0.1.6 | desktop |
| anyhow | 1.0.104 | see crate | https://crates.io/crates/anyhow/1.0.104 | desktop |
| arbitrary | 1.5.0 | see crate | https://crates.io/crates/arbitrary/1.5.0 | desktop |
| async-broadcast | 0.7.2 | see crate | https://crates.io/crates/async-broadcast/0.7.2 | desktop |
| async-channel | 2.5.0 | see crate | https://crates.io/crates/async-channel/2.5.0 | desktop |
| async-executor | 1.14.0 | see crate | https://crates.io/crates/async-executor/1.14.0 | desktop |
| async-io | 2.6.0 | see crate | https://crates.io/crates/async-io/2.6.0 | desktop |
| async-lock | 3.4.2 | see crate | https://crates.io/crates/async-lock/3.4.2 | desktop |
| async-process | 2.5.0 | see crate | https://crates.io/crates/async-process/2.5.0 | desktop |
| async-recursion | 1.2.0 | see crate | https://crates.io/crates/async-recursion/1.2.0 | desktop |
| async-signal | 0.2.14 | see crate | https://crates.io/crates/async-signal/0.2.14 | desktop |
| async-task | 4.7.1 | see crate | https://crates.io/crates/async-task/4.7.1 | desktop |
| async-trait | 0.1.92 | see crate | https://crates.io/crates/async-trait/0.1.92 | desktop |
| atk | 0.18.2 | see crate | https://crates.io/crates/atk/0.18.2 | desktop |
| atk-sys | 0.18.2 | see crate | https://crates.io/crates/atk-sys/0.18.2 | desktop |
| atomic-waker | 1.1.2 | see crate | https://crates.io/crates/atomic-waker/1.1.2 | desktop |
| auto-launch | 0.6.0 | see crate | https://crates.io/crates/auto-launch/0.6.0 | desktop |
| autocfg | 1.5.1 | see crate | https://crates.io/crates/autocfg/1.5.1 | desktop |
| base64 | 0.21.7 | see crate | https://crates.io/crates/base64/0.21.7 | desktop |
| base64 | 0.22.1 | see crate | https://crates.io/crates/base64/0.22.1 | daemon, desktop |
| base64 | 0.23.1 | see crate | https://crates.io/crates/base64/0.23.1 | desktop |
| bit-set | 0.8.0 | see crate | https://crates.io/crates/bit-set/0.8.0 | daemon, desktop |
| bit-vec | 0.8.0 | see crate | https://crates.io/crates/bit-vec/0.8.0 | daemon, desktop |
| bitflags | 1.3.2 | see crate | https://crates.io/crates/bitflags/1.3.2 | desktop |
| bitflags | 2.13.2 | see crate | https://crates.io/crates/bitflags/2.13.2 | desktop |
| block-buffer | 0.10.4 | see crate | https://crates.io/crates/block-buffer/0.10.4 | daemon, desktop |
| block2 | 0.6.2 | see crate | https://crates.io/crates/block2/0.6.2 | desktop |
| blocking | 1.7.0 | see crate | https://crates.io/crates/blocking/1.7.0 | desktop |
| brotli | 9.0.0 | see crate | https://crates.io/crates/brotli/9.0.0 | desktop |
| brotli-decompressor | 6.0.1 | see crate | https://crates.io/crates/brotli-decompressor/6.0.1 | desktop |
| bs58 | 0.5.1 | see crate | https://crates.io/crates/bs58/0.5.1 | desktop |
| bstr | 1.13.1 | see crate | https://crates.io/crates/bstr/1.13.1 | daemon |
| bumpalo | 3.20.3 | see crate | https://crates.io/crates/bumpalo/3.20.3 | desktop |
| bytemuck | 1.25.2 | see crate | https://crates.io/crates/bytemuck/1.25.2 | desktop |
| byteorder | 1.5.0 | see crate | https://crates.io/crates/byteorder/1.5.0 | desktop |
| bytes | 1.12.1 | see crate | https://crates.io/crates/bytes/1.12.1 | daemon, desktop |
| cairo-rs | 0.18.5 | see crate | https://crates.io/crates/cairo-rs/0.18.5 | desktop |
| cairo-sys-rs | 0.18.2 | see crate | https://crates.io/crates/cairo-sys-rs/0.18.2 | desktop |
| camino | 1.2.6 | see crate | https://crates.io/crates/camino/1.2.6 | desktop |
| cargo_metadata | 0.19.2 | see crate | https://crates.io/crates/cargo_metadata/0.19.2 | desktop |
| cargo_toml | 1.0.1 | see crate | https://crates.io/crates/cargo_toml/1.0.1 | desktop |
| cargo-platform | 0.1.9 | see crate | https://crates.io/crates/cargo-platform/0.1.9 | desktop |
| cc | 1.8.0 | see crate | https://crates.io/crates/cc/1.8.0 | daemon, desktop |
| cesu8 | 1.1.0 | see crate | https://crates.io/crates/cesu8/1.1.0 | desktop |
| cfb | 0.14.0 | see crate | https://crates.io/crates/cfb/0.14.0 | desktop |
| cfg_aliases | 0.2.2 | see crate | https://crates.io/crates/cfg_aliases/0.2.2 | desktop |
| cfg-expr | 0.15.8 | see crate | https://crates.io/crates/cfg-expr/0.15.8 | desktop |
| cfg-if | 1.0.5 | see crate | https://crates.io/crates/cfg-if/1.0.5 | daemon, desktop |
| chrono | 0.4.45 | see crate | https://crates.io/crates/chrono/0.4.45 | desktop |
| combine | 4.6.9 | see crate | https://crates.io/crates/combine/4.6.9 | desktop |
| concurrent-queue | 2.5.0 | see crate | https://crates.io/crates/concurrent-queue/2.5.0 | desktop |
| const-random | 0.1.18 | see crate | https://crates.io/crates/const-random/0.1.18 | desktop |
| const-random-macro | 0.1.16 | see crate | https://crates.io/crates/const-random-macro/0.1.16 | desktop |
| cookie | 0.18.2 | see crate | https://crates.io/crates/cookie/0.18.2 | desktop |
| core_detect | 1.0.0 | see crate | https://crates.io/crates/core_detect/1.0.0 | daemon |
| core-foundation | 0.10.1 | see crate | https://crates.io/crates/core-foundation/0.10.1 | desktop |
| core-foundation | 0.9.4 | see crate | https://crates.io/crates/core-foundation/0.9.4 | desktop |
| core-foundation-sys | 0.8.7 | see crate | https://crates.io/crates/core-foundation-sys/0.8.7 | desktop |
| core-graphics | 0.25.0 | see crate | https://crates.io/crates/core-graphics/0.25.0 | desktop |
| core-graphics-types | 0.2.0 | see crate | https://crates.io/crates/core-graphics-types/0.2.0 | desktop |
| cpufeatures | 0.2.17 | see crate | https://crates.io/crates/cpufeatures/0.2.17 | daemon, desktop |
| crc32fast | 1.5.2 | see crate | https://crates.io/crates/crc32fast/1.5.2 | desktop |
| crossbeam-channel | 0.5.17 | see crate | https://crates.io/crates/crossbeam-channel/0.5.17 | desktop |
| crossbeam-deque | 0.8.8 | see crate | https://crates.io/crates/crossbeam-deque/0.8.8 | daemon |
| crossbeam-epoch | 0.9.21 | see crate | https://crates.io/crates/crossbeam-epoch/0.9.21 | daemon |
| crossbeam-utils | 0.8.23 | see crate | https://crates.io/crates/crossbeam-utils/0.8.23 | daemon, desktop |
| crunchy | 0.2.4 | see crate | https://crates.io/crates/crunchy/0.2.4 | desktop |
| crypto-common | 0.1.7 | see crate | https://crates.io/crates/crypto-common/0.1.7 | daemon, desktop |
| cssparser | 0.37.0 | see crate | https://crates.io/crates/cssparser/0.37.0 | desktop |
| cssparser-macros | 0.7.1 | see crate | https://crates.io/crates/cssparser-macros/0.7.1 | desktop |
| ctor | 1.0.13 | see crate | https://crates.io/crates/ctor/1.0.13 | desktop |
| darling | 0.24.1 | see crate | https://crates.io/crates/darling/0.24.1 | desktop |
| darling_core | 0.24.1 | see crate | https://crates.io/crates/darling_core/0.24.1 | desktop |
| darling_macro | 0.24.1 | see crate | https://crates.io/crates/darling_macro/0.24.1 | desktop |
| data-encoding | 2.11.1 | see crate | https://crates.io/crates/data-encoding/2.11.1 | daemon |
| dbus | 0.9.12 | see crate | https://crates.io/crates/dbus/0.9.12 | desktop |
| defmt | 1.2.0 | see crate | https://crates.io/crates/defmt/1.2.0 | desktop |
| defmt-macros | 1.2.0 | see crate | https://crates.io/crates/defmt-macros/1.2.0 | desktop |
| defmt-parser | 1.1.0 | see crate | https://crates.io/crates/defmt-parser/1.1.0 | desktop |
| deranged | 0.5.9 | see crate | https://crates.io/crates/deranged/0.5.9 | desktop |
| derive_arbitrary | 1.5.0 | see crate | https://crates.io/crates/derive_arbitrary/1.5.0 | desktop |
| derive_more | 2.1.1 | see crate | https://crates.io/crates/derive_more/2.1.1 | desktop |
| derive_more-impl | 2.1.1 | see crate | https://crates.io/crates/derive_more-impl/2.1.1 | desktop |
| digest | 0.10.7 | see crate | https://crates.io/crates/digest/0.10.7 | daemon, desktop |
| dirs | 6.0.0 | see crate | https://crates.io/crates/dirs/6.0.0 | desktop |
| dirs | 7.0.0 | see crate | https://crates.io/crates/dirs/7.0.0 | desktop |
| dirs-sys | 0.5.0 | see crate | https://crates.io/crates/dirs-sys/0.5.0 | desktop |
| dispatch2 | 0.3.1 | see crate | https://crates.io/crates/dispatch2/0.3.1 | desktop |
| displaydoc | 0.2.7 | see crate | https://crates.io/crates/displaydoc/0.2.7 | desktop |
| dlopen2 | 0.8.2 | see crate | https://crates.io/crates/dlopen2/0.8.2 | desktop |
| dlopen2_derive | 0.4.3 | see crate | https://crates.io/crates/dlopen2_derive/0.4.3 | desktop |
| dlv-list | 0.5.2 | see crate | https://crates.io/crates/dlv-list/0.5.2 | desktop |
| dom_query | 0.28.0 | see crate | https://crates.io/crates/dom_query/0.28.0 | desktop |
| dpi | 0.1.2 | see crate | https://crates.io/crates/dpi/0.1.2 | desktop |
| dtoa | 1.0.11 | see crate | https://crates.io/crates/dtoa/1.0.11 | desktop |
| dtoa-short | 0.3.5 | see crate | https://crates.io/crates/dtoa-short/0.3.5 | desktop |
| dunce | 1.0.5 | see crate | https://crates.io/crates/dunce/1.0.5 | desktop |
| dyn-clone | 1.0.20 | see crate | https://crates.io/crates/dyn-clone/1.0.20 | desktop |
| embed_plist | 1.2.2 | see crate | https://crates.io/crates/embed_plist/1.2.2 | desktop |
| embed-resource | 3.0.12 | see crate | https://crates.io/crates/embed-resource/3.0.12 | desktop |
| encoding_rs | 0.8.42 | see crate | https://crates.io/crates/encoding_rs/0.8.42 | daemon |
| encoding_rs_io | 0.1.8 | see crate | https://crates.io/crates/encoding_rs_io/0.1.8 | daemon |
| endi | 1.1.1 | see crate | https://crates.io/crates/endi/1.1.1 | desktop |
| enumflags2 | 0.7.12 | see crate | https://crates.io/crates/enumflags2/0.7.12 | desktop |
| enumflags2_derive | 0.7.12 | see crate | https://crates.io/crates/enumflags2_derive/0.7.12 | desktop |
| equivalent | 1.0.3 | see crate | https://crates.io/crates/equivalent/1.0.3 | daemon, desktop |
| erased-serde | 0.4.10 | see crate | https://crates.io/crates/erased-serde/0.4.10 | desktop |
| errno | 0.3.14 | see crate | https://crates.io/crates/errno/0.3.14 | daemon, desktop |
| event-listener | 5.4.2 | see crate | https://crates.io/crates/event-listener/5.4.2 | desktop |
| event-listener-strategy | 0.5.4 | see crate | https://crates.io/crates/event-listener-strategy/0.5.4 | desktop |
| fancy-regex | 0.14.0 | see crate | https://crates.io/crates/fancy-regex/0.14.0 | daemon |
| fastrand | 2.5.0 | see crate | https://crates.io/crates/fastrand/2.5.0 | desktop |
| fdeflate | 0.3.7 | see crate | https://crates.io/crates/fdeflate/0.3.7 | desktop |
| field-offset | 0.3.6 | see crate | https://crates.io/crates/field-offset/0.3.6 | desktop |
| filetime | 0.2.29 | see crate | https://crates.io/crates/filetime/0.2.29 | desktop |
| find-msvc-tools | 0.1.14 | see crate | https://crates.io/crates/find-msvc-tools/0.1.14 | daemon, desktop |
| flate2 | 1.1.10 | see crate | https://crates.io/crates/flate2/1.1.10 | desktop |
| fnv | 1.0.7 | see crate | https://crates.io/crates/fnv/1.0.7 | desktop |
| foldhash | 0.2.0 | see crate | https://crates.io/crates/foldhash/0.2.0 | daemon, desktop |
| foreign-types | 0.5.0 | see crate | https://crates.io/crates/foreign-types/0.5.0 | desktop |
| foreign-types-macros | 0.2.4 | see crate | https://crates.io/crates/foreign-types-macros/0.2.4 | desktop |
| foreign-types-shared | 0.3.1 | see crate | https://crates.io/crates/foreign-types-shared/0.3.1 | desktop |
| form_urlencoded | 1.2.2 | see crate | https://crates.io/crates/form_urlencoded/1.2.2 | desktop |
| futures-channel | 0.3.34 | see crate | https://crates.io/crates/futures-channel/0.3.34 | desktop |
| futures-core | 0.3.34 | see crate | https://crates.io/crates/futures-core/0.3.34 | daemon, desktop |
| futures-executor | 0.3.34 | see crate | https://crates.io/crates/futures-executor/0.3.34 | desktop |
| futures-io | 0.3.34 | see crate | https://crates.io/crates/futures-io/0.3.34 | desktop |
| futures-lite | 2.6.1 | see crate | https://crates.io/crates/futures-lite/2.6.1 | desktop |
| futures-macro | 0.3.34 | see crate | https://crates.io/crates/futures-macro/0.3.34 | desktop |
| futures-sink | 0.3.34 | see crate | https://crates.io/crates/futures-sink/0.3.34 | daemon, desktop |
| futures-task | 0.3.34 | see crate | https://crates.io/crates/futures-task/0.3.34 | daemon, desktop |
| futures-util | 0.3.34 | see crate | https://crates.io/crates/futures-util/0.3.34 | daemon, desktop |
| gdk | 0.18.2 | see crate | https://crates.io/crates/gdk/0.18.2 | desktop |
| gdk-pixbuf | 0.18.5 | see crate | https://crates.io/crates/gdk-pixbuf/0.18.5 | desktop |
| gdk-pixbuf-sys | 0.18.0 | see crate | https://crates.io/crates/gdk-pixbuf-sys/0.18.0 | desktop |
| gdk-sys | 0.18.2 | see crate | https://crates.io/crates/gdk-sys/0.18.2 | desktop |
| gdkwayland-sys | 0.18.2 | see crate | https://crates.io/crates/gdkwayland-sys/0.18.2 | desktop |
| gdkx11 | 0.18.2 | see crate | https://crates.io/crates/gdkx11/0.18.2 | desktop |
| gdkx11-sys | 0.18.2 | see crate | https://crates.io/crates/gdkx11-sys/0.18.2 | desktop |
| generic-array | 0.14.7 | see crate | https://crates.io/crates/generic-array/0.14.7 | daemon, desktop |
| gethostname | 1.1.0 | see crate | https://crates.io/crates/gethostname/1.1.0 | desktop |
| getrandom | 0.2.17 | see crate | https://crates.io/crates/getrandom/0.2.17 | daemon, desktop |
| getrandom | 0.3.4 | see crate | https://crates.io/crates/getrandom/0.3.4 | daemon, desktop |
| getrandom | 0.4.3 | see crate | https://crates.io/crates/getrandom/0.4.3 | desktop |
| gio | 0.18.4 | see crate | https://crates.io/crates/gio/0.18.4 | desktop |
| gio-sys | 0.18.1 | see crate | https://crates.io/crates/gio-sys/0.18.1 | desktop |
| glib | 0.18.5 | see crate | https://crates.io/crates/glib/0.18.5 | desktop |
| glib-macros | 0.18.5 | see crate | https://crates.io/crates/glib-macros/0.18.5 | desktop |
| glib-sys | 0.18.1 | see crate | https://crates.io/crates/glib-sys/0.18.1 | desktop |
| glob | 0.3.4 | see crate | https://crates.io/crates/glob/0.3.4 | desktop |
| global-hotkey | 0.8.0 | see crate | https://crates.io/crates/global-hotkey/0.8.0 | desktop |
| globset | 0.4.20 | see crate | https://crates.io/crates/globset/0.4.20 | daemon |
| gobject-sys | 0.18.0 | see crate | https://crates.io/crates/gobject-sys/0.18.0 | desktop |
| grep-matcher | 0.1.9 | see crate | https://crates.io/crates/grep-matcher/0.1.9 | daemon |
| grep-printer | 0.3.1 | see crate | https://crates.io/crates/grep-printer/0.3.1 | daemon |
| grep-regex | 0.1.14 | see crate | https://crates.io/crates/grep-regex/0.1.14 | daemon |
| grep-searcher | 0.1.17 | see crate | https://crates.io/crates/grep-searcher/0.1.17 | daemon |
| gtk | 0.18.2 | see crate | https://crates.io/crates/gtk/0.18.2 | desktop |
| gtk-sys | 0.18.2 | see crate | https://crates.io/crates/gtk-sys/0.18.2 | desktop |
| gtk3-macros | 0.18.2 | see crate | https://crates.io/crates/gtk3-macros/0.18.2 | desktop |
| hashbrown | 0.12.3 | see crate | https://crates.io/crates/hashbrown/0.12.3 | desktop |
| hashbrown | 0.14.5 | see crate | https://crates.io/crates/hashbrown/0.14.5 | desktop |
| hashbrown | 0.17.1 | see crate | https://crates.io/crates/hashbrown/0.17.1 | daemon, desktop |
| heck | 0.4.1 | see crate | https://crates.io/crates/heck/0.4.1 | desktop |
| heck | 0.5.0 | see crate | https://crates.io/crates/heck/0.5.0 | desktop |
| hermit-abi | 0.5.3 | see crate | https://crates.io/crates/hermit-abi/0.5.3 | desktop |
| hex | 0.4.3 | see crate | https://crates.io/crates/hex/0.4.3 | desktop |
| html5ever | 0.39.0 | see crate | https://crates.io/crates/html5ever/0.39.0 | desktop |
| http | 1.5.0 | see crate | https://crates.io/crates/http/1.5.0 | daemon, desktop |
| http-body | 1.1.0 | see crate | https://crates.io/crates/http-body/1.1.0 | desktop |
| http-body-util | 0.1.5 | see crate | https://crates.io/crates/http-body-util/0.1.5 | desktop |
| httparse | 1.10.1 | see crate | https://crates.io/crates/httparse/1.10.1 | daemon, desktop |
| hyper | 1.12.0 | see crate | https://crates.io/crates/hyper/1.12.0 | desktop |
| hyper-rustls | 0.27.10 | see crate | https://crates.io/crates/hyper-rustls/0.27.10 | desktop |
| hyper-util | 0.1.21 | see crate | https://crates.io/crates/hyper-util/0.1.21 | desktop |
| iana-time-zone | 0.1.65 | see crate | https://crates.io/crates/iana-time-zone/0.1.65 | desktop |
| iana-time-zone-haiku | 0.1.2 | see crate | https://crates.io/crates/iana-time-zone-haiku/0.1.2 | desktop |
| ico | 0.5.0 | see crate | https://crates.io/crates/ico/0.5.0 | desktop |
| icu_collections | 2.3.0 | see crate | https://crates.io/crates/icu_collections/2.3.0 | desktop |
| icu_locale_core | 2.3.0 | see crate | https://crates.io/crates/icu_locale_core/2.3.0 | desktop |
| icu_normalizer | 2.3.0 | see crate | https://crates.io/crates/icu_normalizer/2.3.0 | desktop |
| icu_normalizer_data | 2.3.0 | see crate | https://crates.io/crates/icu_normalizer_data/2.3.0 | desktop |
| icu_properties | 2.3.0 | see crate | https://crates.io/crates/icu_properties/2.3.0 | desktop |
| icu_properties_data | 2.3.0 | see crate | https://crates.io/crates/icu_properties_data/2.3.0 | desktop |
| icu_provider | 2.3.1 | see crate | https://crates.io/crates/icu_provider/2.3.1 | desktop |
| ident_case | 1.0.1 | see crate | https://crates.io/crates/ident_case/1.0.1 | desktop |
| idna | 1.1.0 | see crate | https://crates.io/crates/idna/1.1.0 | desktop |
| idna_adapter | 1.2.2 | see crate | https://crates.io/crates/idna_adapter/1.2.2 | desktop |
| ignore | 0.4.33 | see crate | https://crates.io/crates/ignore/0.4.33 | daemon |
| indexmap | 1.9.3 | see crate | https://crates.io/crates/indexmap/1.9.3 | desktop |
| indexmap | 2.14.2 | see crate | https://crates.io/crates/indexmap/2.14.2 | daemon, desktop |
| infer | 0.22.0 | see crate | https://crates.io/crates/infer/0.22.0 | desktop |
| ipnet | 2.12.2 | see crate | https://crates.io/crates/ipnet/2.12.2 | desktop |
| is-docker | 0.2.0 | see crate | https://crates.io/crates/is-docker/0.2.0 | desktop |
| is-wsl | 0.4.0 | see crate | https://crates.io/crates/is-wsl/0.4.0 | desktop |
| itoa | 1.0.18 | see crate | https://crates.io/crates/itoa/1.0.18 | daemon, desktop |
| javascriptcore-rs | 1.1.2 | see crate | https://crates.io/crates/javascriptcore-rs/1.1.2 | desktop |
| javascriptcore-rs-sys | 1.1.1 | see crate | https://crates.io/crates/javascriptcore-rs-sys/1.1.1 | desktop |
| jiff | 0.2.38 | see crate | https://crates.io/crates/jiff/0.2.38 | desktop |
| jiff-core | 0.1.1 | see crate | https://crates.io/crates/jiff-core/0.1.1 | desktop |
| jiff-static | 0.2.38 | see crate | https://crates.io/crates/jiff-static/0.2.38 | desktop |
| jiff-tzdb | 0.1.9 | see crate | https://crates.io/crates/jiff-tzdb/0.1.9 | desktop |
| jiff-tzdb-platform | 0.1.3 | see crate | https://crates.io/crates/jiff-tzdb-platform/0.1.3 | desktop |
| jni | 0.21.1 | see crate | https://crates.io/crates/jni/0.21.1 | desktop |
| jni | 0.22.4 | see crate | https://crates.io/crates/jni/0.22.4 | desktop |
| jni-macros | 0.22.4 | see crate | https://crates.io/crates/jni-macros/0.22.4 | desktop |
| jni-sys | 0.3.1 | see crate | https://crates.io/crates/jni-sys/0.3.1 | desktop |
| jni-sys | 0.4.1 | see crate | https://crates.io/crates/jni-sys/0.4.1 | desktop |
| jni-sys-macros | 0.4.1 | see crate | https://crates.io/crates/jni-sys-macros/0.4.1 | desktop |
| js-sys | 0.3.106 | see crate | https://crates.io/crates/js-sys/0.3.106 | desktop |
| json-patch | 4.2.0 | see crate | https://crates.io/crates/json-patch/4.2.0 | desktop |
| jsonptr | 0.7.1 | see crate | https://crates.io/crates/jsonptr/0.7.1 | desktop |
| keyboard-types | 0.7.0 | see crate | https://crates.io/crates/keyboard-types/0.7.0 | desktop |
| keyboard-types | 0.8.3 | see crate | https://crates.io/crates/keyboard-types/0.8.3 | desktop |
| libappindicator | 0.9.0 | see crate | https://crates.io/crates/libappindicator/0.9.0 | desktop |
| libappindicator-sys | 0.9.0 | see crate | https://crates.io/crates/libappindicator-sys/0.9.0 | desktop |
| libc | 0.2.190 | see crate | https://crates.io/crates/libc/0.2.190 | desktop |
| libc | 0.2.191 | see crate | https://crates.io/crates/libc/0.2.191 | daemon |
| libdbus-sys | 0.2.7 | see crate | https://crates.io/crates/libdbus-sys/0.2.7 | desktop |
| libloading | 0.7.4 | see crate | https://crates.io/crates/libloading/0.7.4 | desktop |
| libredox | 0.1.25 | see crate | https://crates.io/crates/libredox/0.1.25 | desktop |
| linux-raw-sys | 0.12.1 | see crate | https://crates.io/crates/linux-raw-sys/0.12.1 | desktop |
| litemap | 0.8.3 | see crate | https://crates.io/crates/litemap/0.8.3 | desktop |
| lock_api | 0.4.14 | see crate | https://crates.io/crates/lock_api/0.4.14 | desktop |
| log | 0.4.34 | see crate | https://crates.io/crates/log/0.4.34 | daemon, desktop |
| mac-notification-sys | 0.6.15 | see crate | https://crates.io/crates/mac-notification-sys/0.6.15 | desktop |
| markup5ever | 0.39.0 | see crate | https://crates.io/crates/markup5ever/0.39.0 | desktop |
| memchr | 2.8.3 | see crate | https://crates.io/crates/memchr/2.8.3 | daemon, desktop |
| memmap2 | 0.9.11 | see crate | https://crates.io/crates/memmap2/0.9.11 | daemon |
| memoffset | 0.9.1 | see crate | https://crates.io/crates/memoffset/0.9.1 | desktop |
| mime | 0.3.17 | see crate | https://crates.io/crates/mime/0.3.17 | desktop |
| minisign-verify | 0.2.5 | see crate | https://crates.io/crates/minisign-verify/0.2.5 | daemon |
| minisign-verify | 0.3.0 | see crate | https://crates.io/crates/minisign-verify/0.3.0 | desktop |
| miniz_oxide | 0.8.9 | see crate | https://crates.io/crates/miniz_oxide/0.8.9 | desktop |
| miniz_oxide | 0.9.1 | see crate | https://crates.io/crates/miniz_oxide/0.9.1 | desktop |
| mio | 1.2.4 | see crate | https://crates.io/crates/mio/1.2.4 | daemon, desktop |
| muda | 0.20.0 | see crate | https://crates.io/crates/muda/0.20.0 | desktop |
| multiversion_no_op | 1.0.0 | see crate | https://crates.io/crates/multiversion_no_op/1.0.0 | daemon |
| ndk | 0.9.0 | see crate | https://crates.io/crates/ndk/0.9.0 | desktop |
| ndk-context | 0.1.1 | see crate | https://crates.io/crates/ndk-context/0.1.1 | desktop |
| ndk-sys | 0.6.0+11769913 | see crate | https://crates.io/crates/ndk-sys/0.6.0+11769913 | desktop |
| new_debug_unreachable | 1.0.6 | see crate | https://crates.io/crates/new_debug_unreachable/1.0.6 | desktop |
| nix | 0.31.3 | see crate | https://crates.io/crates/nix/0.31.3 | desktop |
| notify-rust | 4.18.2 | see crate | https://crates.io/crates/notify-rust/4.18.2 | desktop |
| num_enum | 0.7.6 | see crate | https://crates.io/crates/num_enum/0.7.6 | desktop |
| num_enum_derive | 0.7.6 | see crate | https://crates.io/crates/num_enum_derive/0.7.6 | desktop |
| num-conv | 0.2.2 | see crate | https://crates.io/crates/num-conv/0.2.2 | desktop |
| num-traits | 0.2.19 | see crate | https://crates.io/crates/num-traits/0.2.19 | desktop |
| objc2 | 0.6.5 | see crate | https://crates.io/crates/objc2/0.6.5 | desktop |
| objc2-app-kit | 0.3.2 | see crate | https://crates.io/crates/objc2-app-kit/0.3.2 | desktop |
| objc2-cloud-kit | 0.3.2 | see crate | https://crates.io/crates/objc2-cloud-kit/0.3.2 | desktop |
| objc2-core-data | 0.3.2 | see crate | https://crates.io/crates/objc2-core-data/0.3.2 | desktop |
| objc2-core-foundation | 0.3.2 | see crate | https://crates.io/crates/objc2-core-foundation/0.3.2 | desktop |
| objc2-core-graphics | 0.3.2 | see crate | https://crates.io/crates/objc2-core-graphics/0.3.2 | desktop |
| objc2-core-image | 0.3.2 | see crate | https://crates.io/crates/objc2-core-image/0.3.2 | desktop |
| objc2-core-location | 0.3.2 | see crate | https://crates.io/crates/objc2-core-location/0.3.2 | desktop |
| objc2-core-text | 0.3.2 | see crate | https://crates.io/crates/objc2-core-text/0.3.2 | desktop |
| objc2-encode | 4.1.0 | see crate | https://crates.io/crates/objc2-encode/4.1.0 | desktop |
| objc2-exception-helper | 0.1.1 | see crate | https://crates.io/crates/objc2-exception-helper/0.1.1 | desktop |
| objc2-foundation | 0.3.2 | see crate | https://crates.io/crates/objc2-foundation/0.3.2 | desktop |
| objc2-io-surface | 0.3.2 | see crate | https://crates.io/crates/objc2-io-surface/0.3.2 | desktop |
| objc2-osa-kit | 0.3.2 | see crate | https://crates.io/crates/objc2-osa-kit/0.3.2 | desktop |
| objc2-quartz-core | 0.3.2 | see crate | https://crates.io/crates/objc2-quartz-core/0.3.2 | desktop |
| objc2-security | 0.3.2 | see crate | https://crates.io/crates/objc2-security/0.3.2 | desktop |
| objc2-service-management | 0.3.2 | see crate | https://crates.io/crates/objc2-service-management/0.3.2 | desktop |
| objc2-ui-kit | 0.3.2 | see crate | https://crates.io/crates/objc2-ui-kit/0.3.2 | desktop |
| objc2-user-notifications | 0.3.2 | see crate | https://crates.io/crates/objc2-user-notifications/0.3.2 | desktop |
| objc2-web-kit | 0.3.2 | see crate | https://crates.io/crates/objc2-web-kit/0.3.2 | desktop |
| once_cell | 1.21.4 | see crate | https://crates.io/crates/once_cell/1.21.4 | daemon, desktop |
| open | 5.4.4 | see crate | https://crates.io/crates/open/5.4.4 | desktop |
| openssl-probe | 0.2.1 | see crate | https://crates.io/crates/openssl-probe/0.2.1 | desktop |
| option-ext | 0.2.0 | see crate | https://crates.io/crates/option-ext/0.2.0 | desktop |
| ordered-multimap | 0.7.3 | see crate | https://crates.io/crates/ordered-multimap/0.7.3 | desktop |
| ordered-stream | 0.2.0 | see crate | https://crates.io/crates/ordered-stream/0.2.0 | desktop |
| os_info | 3.15.0 | see crate | https://crates.io/crates/os_info/3.15.0 | desktop |
| osakit | 0.3.1 | see crate | https://crates.io/crates/osakit/0.3.1 | desktop |
| pango | 0.18.3 | see crate | https://crates.io/crates/pango/0.18.3 | desktop |
| pango-sys | 0.18.0 | see crate | https://crates.io/crates/pango-sys/0.18.0 | desktop |
| parking | 2.2.1 | see crate | https://crates.io/crates/parking/2.2.1 | desktop |
| parking_lot | 0.12.5 | see crate | https://crates.io/crates/parking_lot/0.12.5 | desktop |
| parking_lot_core | 0.9.12 | see crate | https://crates.io/crates/parking_lot_core/0.9.12 | desktop |
| percent-encoding | 2.3.2 | see crate | https://crates.io/crates/percent-encoding/2.3.2 | desktop |
| phf | 0.13.1 | see crate | https://crates.io/crates/phf/0.13.1 | desktop |
| phf_codegen | 0.13.1 | see crate | https://crates.io/crates/phf_codegen/0.13.1 | desktop |
| phf_generator | 0.13.1 | see crate | https://crates.io/crates/phf_generator/0.13.1 | desktop |
| phf_macros | 0.13.1 | see crate | https://crates.io/crates/phf_macros/0.13.1 | desktop |
| phf_shared | 0.13.1 | see crate | https://crates.io/crates/phf_shared/0.13.1 | desktop |
| pin-project-lite | 0.2.17 | see crate | https://crates.io/crates/pin-project-lite/0.2.17 | daemon, desktop |
| piper | 0.2.5 | see crate | https://crates.io/crates/piper/0.2.5 | desktop |
| pkg-config | 0.3.34 | see crate | https://crates.io/crates/pkg-config/0.3.34 | desktop |
| plist | 1.10.1 | see crate | https://crates.io/crates/plist/1.10.1 | desktop |
| png | 0.17.16 | see crate | https://crates.io/crates/png/0.17.16 | desktop |
| png | 0.18.1 | see crate | https://crates.io/crates/png/0.18.1 | desktop |
| polling | 3.11.0 | see crate | https://crates.io/crates/polling/3.11.0 | desktop |
| portable-atomic | 1.15.0 | see crate | https://crates.io/crates/portable-atomic/1.15.0 | desktop |
| portable-atomic-util | 0.2.8 | see crate | https://crates.io/crates/portable-atomic-util/0.2.8 | desktop |
| potential_utf | 0.1.6 | see crate | https://crates.io/crates/potential_utf/0.1.6 | desktop |
| powerfmt | 0.2.1 | see crate | https://crates.io/crates/powerfmt/0.2.1 | desktop |
| ppv-lite86 | 0.2.21 | see crate | https://crates.io/crates/ppv-lite86/0.2.21 | daemon, desktop |
| precomputed-hash | 0.1.1 | see crate | https://crates.io/crates/precomputed-hash/0.1.1 | desktop |
| proc-macro-crate | 1.3.1 | see crate | https://crates.io/crates/proc-macro-crate/1.3.1 | desktop |
| proc-macro-crate | 2.0.2 | see crate | https://crates.io/crates/proc-macro-crate/2.0.2 | desktop |
| proc-macro-crate | 3.5.0 | see crate | https://crates.io/crates/proc-macro-crate/3.5.0 | desktop |
| proc-macro-error | 1.0.4 | see crate | https://crates.io/crates/proc-macro-error/1.0.4 | desktop |
| proc-macro-error-attr | 1.0.4 | see crate | https://crates.io/crates/proc-macro-error-attr/1.0.4 | desktop |
| proc-macro2 | 1.0.107 | see crate | https://crates.io/crates/proc-macro2/1.0.107 | daemon, desktop |
| quick-xml | 0.42.0 | see crate | https://crates.io/crates/quick-xml/0.42.0 | desktop |
| quote | 1.0.47 | see crate | https://crates.io/crates/quote/1.0.47 | daemon, desktop |
| r-efi | 5.3.0 | see crate | https://crates.io/crates/r-efi/5.3.0 | daemon, desktop |
| r-efi | 6.0.0 | see crate | https://crates.io/crates/r-efi/6.0.0 | desktop |
| rand | 0.9.5 | see crate | https://crates.io/crates/rand/0.9.5 | daemon, desktop |
| rand_chacha | 0.9.0 | see crate | https://crates.io/crates/rand_chacha/0.9.0 | daemon, desktop |
| rand_core | 0.9.5 | see crate | https://crates.io/crates/rand_core/0.9.5 | daemon, desktop |
| raw-window-handle | 0.6.2 | see crate | https://crates.io/crates/raw-window-handle/0.6.2 | desktop |
| redox_syscall | 0.5.18 | see crate | https://crates.io/crates/redox_syscall/0.5.18 | desktop |
| redox_users | 0.5.3 | see crate | https://crates.io/crates/redox_users/0.5.3 | desktop |
| ref-cast | 1.0.27 | see crate | https://crates.io/crates/ref-cast/1.0.27 | desktop |
| ref-cast-impl | 1.0.27 | see crate | https://crates.io/crates/ref-cast-impl/1.0.27 | desktop |
| regex | 1.13.1 | see crate | https://crates.io/crates/regex/1.13.1 | daemon, desktop |
| regex-automata | 0.4.18 | see crate | https://crates.io/crates/regex-automata/0.4.18 | daemon, desktop |
| regex-syntax | 0.8.11 | see crate | https://crates.io/crates/regex-syntax/0.8.11 | daemon, desktop |
| reqwest | 0.13.5 | see crate | https://crates.io/crates/reqwest/0.13.5 | desktop |
| ring | 0.17.14 | see crate | https://crates.io/crates/ring/0.17.14 | daemon, desktop |
| rust-ini | 0.21.1 | see crate | https://crates.io/crates/rust-ini/0.21.1 | desktop |
| rustc_version | 0.4.1 | see crate | https://crates.io/crates/rustc_version/0.4.1 | desktop |
| rustc-hash | 2.1.3 | see crate | https://crates.io/crates/rustc-hash/2.1.3 | desktop |
| rustix | 1.1.5 | see crate | https://crates.io/crates/rustix/1.1.5 | desktop |
| rustls | 0.23.46 | see crate | https://crates.io/crates/rustls/0.23.46 | daemon, desktop |
| rustls-native-certs | 0.8.5 | see crate | https://crates.io/crates/rustls-native-certs/0.8.5 | desktop |
| rustls-pki-types | 1.15.1 | see crate | https://crates.io/crates/rustls-pki-types/1.15.1 | daemon, desktop |
| rustls-platform-verifier | 0.7.1 | see crate | https://crates.io/crates/rustls-platform-verifier/0.7.1 | desktop |
| rustls-platform-verifier-android | 0.2.0 | see crate | https://crates.io/crates/rustls-platform-verifier-android/0.2.0 | desktop |
| rustls-webpki | 0.103.15 | see crate | https://crates.io/crates/rustls-webpki/0.103.15 | daemon, desktop |
| rustversion | 1.0.23 | see crate | https://crates.io/crates/rustversion/1.0.23 | daemon, desktop |
| ruzstd | 0.8.3 | see crate | https://crates.io/crates/ruzstd/0.8.3 | daemon |
| same-file | 1.0.6 | see crate | https://crates.io/crates/same-file/1.0.6 | daemon, desktop |
| schannel | 0.1.30 | see crate | https://crates.io/crates/schannel/0.1.30 | desktop |
| schemars | 0.8.22 | see crate | https://crates.io/crates/schemars/0.8.22 | desktop |
| schemars | 0.9.0 | see crate | https://crates.io/crates/schemars/0.9.0 | desktop |
| schemars | 1.2.3 | see crate | https://crates.io/crates/schemars/1.2.3 | desktop |
| schemars_derive | 0.8.22 | see crate | https://crates.io/crates/schemars_derive/0.8.22 | desktop |
| scopeguard | 1.2.0 | see crate | https://crates.io/crates/scopeguard/1.2.0 | daemon, desktop |
| security-framework | 3.7.0 | see crate | https://crates.io/crates/security-framework/3.7.0 | desktop |
| security-framework-sys | 2.17.0 | see crate | https://crates.io/crates/security-framework-sys/2.17.0 | desktop |
| selectors | 0.38.0 | see crate | https://crates.io/crates/selectors/0.38.0 | desktop |
| semver | 1.0.28 | see crate | https://crates.io/crates/semver/1.0.28 | desktop |
| serde | 1.0.229 | see crate | https://crates.io/crates/serde/1.0.229 | daemon, desktop |
| serde_core | 1.0.229 | see crate | https://crates.io/crates/serde_core/1.0.229 | daemon, desktop |
| serde_derive | 1.0.229 | see crate | https://crates.io/crates/serde_derive/1.0.229 | daemon, desktop |
| serde_derive_internals | 0.29.1 | see crate | https://crates.io/crates/serde_derive_internals/0.29.1 | desktop |
| serde_json | 1.0.154 | see crate | https://crates.io/crates/serde_json/1.0.154 | daemon, desktop |
| serde_repr | 0.1.21 | see crate | https://crates.io/crates/serde_repr/0.1.21 | desktop |
| serde_spanned | 0.6.9 | see crate | https://crates.io/crates/serde_spanned/0.6.9 | desktop |
| serde_spanned | 1.1.2 | see crate | https://crates.io/crates/serde_spanned/1.1.2 | desktop |
| serde_with | 3.24.0 | see crate | https://crates.io/crates/serde_with/3.24.0 | desktop |
| serde_with_macros | 3.24.0 | see crate | https://crates.io/crates/serde_with_macros/3.24.0 | desktop |
| serde-untagged | 0.1.9 | see crate | https://crates.io/crates/serde-untagged/0.1.9 | desktop |
| serialize-to-javascript | 0.1.2 | see crate | https://crates.io/crates/serialize-to-javascript/0.1.2 | desktop |
| serialize-to-javascript-impl | 0.1.2 | see crate | https://crates.io/crates/serialize-to-javascript-impl/0.1.2 | desktop |
| servo_arc | 0.4.3 | see crate | https://crates.io/crates/servo_arc/0.4.3 | desktop |
| sha1 | 0.10.7 | see crate | https://crates.io/crates/sha1/0.10.7 | daemon |
| sha2 | 0.10.9 | see crate | https://crates.io/crates/sha2/0.10.9 | daemon, desktop |
| shlex | 2.0.1 | see crate | https://crates.io/crates/shlex/2.0.1 | daemon, desktop |
| signal-hook-registry | 1.4.8 | see crate | https://crates.io/crates/signal-hook-registry/1.4.8 | daemon, desktop |
| simd_cesu8 | 1.2.0 | see crate | https://crates.io/crates/simd_cesu8/1.2.0 | desktop |
| simd-adler32 | 0.3.10 | see crate | https://crates.io/crates/simd-adler32/0.3.10 | desktop |
| simdutf8 | 0.1.5 | see crate | https://crates.io/crates/simdutf8/0.1.5 | daemon, desktop |
| siphasher | 1.0.4 | see crate | https://crates.io/crates/siphasher/1.0.4 | desktop |
| slab | 0.4.12 | see crate | https://crates.io/crates/slab/0.4.12 | daemon, desktop |
| smallvec | 1.16.3 | see crate | https://crates.io/crates/smallvec/1.16.3 | desktop |
| smappservice-rs | 0.1.3 | see crate | https://crates.io/crates/smappservice-rs/0.1.3 | desktop |
| socket2 | 0.6.5 | see crate | https://crates.io/crates/socket2/0.6.5 | daemon, desktop |
| softbuffer | 0.4.8 | see crate | https://crates.io/crates/softbuffer/0.4.8 | desktop |
| soup3 | 0.5.0 | see crate | https://crates.io/crates/soup3/0.5.0 | desktop |
| soup3-sys | 0.5.0 | see crate | https://crates.io/crates/soup3-sys/0.5.0 | desktop |
| stable_deref_trait | 1.2.1 | see crate | https://crates.io/crates/stable_deref_trait/1.2.1 | desktop |
| static_vcruntime | 3.0.0 | see crate | https://crates.io/crates/static_vcruntime/3.0.0 | desktop |
| string_cache | 0.9.0 | see crate | https://crates.io/crates/string_cache/0.9.0 | desktop |
| string_cache_codegen | 0.6.1 | see crate | https://crates.io/crates/string_cache_codegen/0.6.1 | desktop |
| strsim | 0.11.1 | see crate | https://crates.io/crates/strsim/0.11.1 | desktop |
| subtle | 2.6.1 | see crate | https://crates.io/crates/subtle/2.6.1 | daemon, desktop |
| swift-rs | 1.0.9 | see crate | https://crates.io/crates/swift-rs/1.0.9 | desktop |
| syn | 1.0.109 | see crate | https://crates.io/crates/syn/1.0.109 | desktop |
| syn | 2.0.119 | see crate | https://crates.io/crates/syn/2.0.119 | daemon, desktop |
| syn | 3.0.9 | see crate | https://crates.io/crates/syn/3.0.9 | daemon, desktop |
| sync_wrapper | 1.0.2 | see crate | https://crates.io/crates/sync_wrapper/1.0.2 | desktop |
| synstructure | 0.14.0 | see crate | https://crates.io/crates/synstructure/0.14.0 | desktop |
| system-configuration | 0.7.0 | see crate | https://crates.io/crates/system-configuration/0.7.0 | desktop |
| system-configuration-sys | 0.6.0 | see crate | https://crates.io/crates/system-configuration-sys/0.6.0 | desktop |
| system-deps | 6.2.2 | see crate | https://crates.io/crates/system-deps/6.2.2 | desktop |
| tao | 0.37.1 | see crate | https://crates.io/crates/tao/0.37.1 | desktop |
| tao-macros | 0.1.4 | see crate | https://crates.io/crates/tao-macros/0.1.4 | desktop |
| tar | 0.4.46 | see crate | https://crates.io/crates/tar/0.4.46 | desktop |
| target-lexicon | 0.12.16 | see crate | https://crates.io/crates/target-lexicon/0.12.16 | desktop |
| tauri | 2.12.4 | see crate | https://crates.io/crates/tauri/2.12.4 | desktop |
| tauri-build | 2.7.3 | see crate | https://crates.io/crates/tauri-build/2.7.3 | desktop |
| tauri-codegen | 2.7.3 | see crate | https://crates.io/crates/tauri-codegen/2.7.3 | desktop |
| tauri-macros | 2.7.3 | see crate | https://crates.io/crates/tauri-macros/2.7.3 | desktop |
| tauri-plugin | 2.7.2 | see crate | https://crates.io/crates/tauri-plugin/2.7.2 | desktop |
| tauri-plugin-autostart | 2.7.0 | see crate | https://crates.io/crates/tauri-plugin-autostart/2.7.0 | desktop |
| tauri-plugin-deep-link | 2.6.2 | see crate | https://crates.io/crates/tauri-plugin-deep-link/2.6.2 | desktop |
| tauri-plugin-global-shortcut | 2.4.1 | see crate | https://crates.io/crates/tauri-plugin-global-shortcut/2.4.1 | desktop |
| tauri-plugin-notification | 2.7.0 | see crate | https://crates.io/crates/tauri-plugin-notification/2.7.0 | desktop |
| tauri-plugin-opener | 2.7.2 | see crate | https://crates.io/crates/tauri-plugin-opener/2.7.2 | desktop |
| tauri-plugin-single-instance | 2.5.4 | see crate | https://crates.io/crates/tauri-plugin-single-instance/2.5.4 | desktop |
| tauri-plugin-updater | 2.14.0 | see crate | https://crates.io/crates/tauri-plugin-updater/2.14.0 | desktop |
| tauri-runtime | 2.12.2 | see crate | https://crates.io/crates/tauri-runtime/2.12.2 | desktop |
| tauri-runtime-wry | 2.12.2 | see crate | https://crates.io/crates/tauri-runtime-wry/2.12.2 | desktop |
| tauri-utils | 2.10.2 | see crate | https://crates.io/crates/tauri-utils/2.10.2 | desktop |
| tauri-winres | 0.3.6 | see crate | https://crates.io/crates/tauri-winres/0.3.6 | desktop |
| tauri-winrt-notification | 0.8.1 | see crate | https://crates.io/crates/tauri-winrt-notification/0.8.1 | desktop |
| tempfile | 3.27.0 | see crate | https://crates.io/crates/tempfile/3.27.0 | desktop |
| tendril | 0.5.1 | see crate | https://crates.io/crates/tendril/0.5.1 | desktop |
| termcolor | 1.4.1 | see crate | https://crates.io/crates/termcolor/1.4.1 | daemon |
| thiserror | 1.0.69 | see crate | https://crates.io/crates/thiserror/1.0.69 | desktop |
| thiserror | 2.0.21 | see crate | https://crates.io/crates/thiserror/2.0.21 | daemon, desktop |
| thiserror-impl | 1.0.69 | see crate | https://crates.io/crates/thiserror-impl/1.0.69 | desktop |
| thiserror-impl | 2.0.21 | see crate | https://crates.io/crates/thiserror-impl/2.0.21 | daemon, desktop |
| time | 0.3.55 | see crate | https://crates.io/crates/time/0.3.55 | desktop |
| time-core | 0.1.9 | see crate | https://crates.io/crates/time-core/0.1.9 | desktop |
| time-macros | 0.2.32 | see crate | https://crates.io/crates/time-macros/0.2.32 | desktop |
| tiny-keccak | 2.0.2 | see crate | https://crates.io/crates/tiny-keccak/2.0.2 | desktop |
| tinystr | 0.8.4 | see crate | https://crates.io/crates/tinystr/0.8.4 | desktop |
| tinyvec | 1.13.3 | see crate | https://crates.io/crates/tinyvec/1.13.3 | desktop |
| tokio | 1.53.3 | see crate | https://crates.io/crates/tokio/1.53.3 | daemon, desktop |
| tokio-macros | 2.7.2 | see crate | https://crates.io/crates/tokio-macros/2.7.2 | daemon |
| tokio-rustls | 0.26.6 | see crate | https://crates.io/crates/tokio-rustls/0.26.6 | daemon, desktop |
| tokio-tungstenite | 0.28.0 | see crate | https://crates.io/crates/tokio-tungstenite/0.28.0 | daemon |
| tokio-util | 0.7.20 | see crate | https://crates.io/crates/tokio-util/0.7.20 | desktop |
| toml | 0.8.2 | see crate | https://crates.io/crates/toml/0.8.2 | desktop |
| toml | 1.1.8+spec-1.1.0 | see crate | https://crates.io/crates/toml/1.1.8+spec-1.1.0 | desktop |
| toml_datetime | 0.6.3 | see crate | https://crates.io/crates/toml_datetime/0.6.3 | desktop |
| toml_datetime | 1.1.2+spec-1.1.0 | see crate | https://crates.io/crates/toml_datetime/1.1.2+spec-1.1.0 | desktop |
| toml_edit | 0.19.15 | see crate | https://crates.io/crates/toml_edit/0.19.15 | desktop |
| toml_edit | 0.20.2 | see crate | https://crates.io/crates/toml_edit/0.20.2 | desktop |
| toml_edit | 0.25.17+spec-1.1.0 | see crate | https://crates.io/crates/toml_edit/0.25.17+spec-1.1.0 | desktop |
| toml_parser | 1.1.5+spec-1.1.0 | see crate | https://crates.io/crates/toml_parser/1.1.5+spec-1.1.0 | desktop |
| toml_writer | 1.1.3+spec-1.1.0 | see crate | https://crates.io/crates/toml_writer/1.1.3+spec-1.1.0 | desktop |
| tower | 0.5.3 | see crate | https://crates.io/crates/tower/0.5.3 | desktop |
| tower-http | 0.6.11 | see crate | https://crates.io/crates/tower-http/0.6.11 | desktop |
| tower-layer | 0.3.3 | see crate | https://crates.io/crates/tower-layer/0.3.3 | desktop |
| tower-service | 0.3.3 | see crate | https://crates.io/crates/tower-service/0.3.3 | desktop |
| tracing | 0.1.44 | see crate | https://crates.io/crates/tracing/0.1.44 | desktop |
| tracing-attributes | 0.1.31 | see crate | https://crates.io/crates/tracing-attributes/0.1.31 | desktop |
| tracing-core | 0.1.36 | see crate | https://crates.io/crates/tracing-core/0.1.36 | desktop |
| tray-icon | 0.25.1 | see crate | https://crates.io/crates/tray-icon/0.25.1 | desktop |
| trim-in-place | 0.1.8 | see crate | https://crates.io/crates/trim-in-place/0.1.8 | desktop |
| try-lock | 0.2.5 | see crate | https://crates.io/crates/try-lock/0.2.5 | desktop |
| tungstenite | 0.28.0 | see crate | https://crates.io/crates/tungstenite/0.28.0 | daemon |
| twox-hash | 2.1.5 | see crate | https://crates.io/crates/twox-hash/2.1.5 | daemon |
| typeid | 1.0.3 | see crate | https://crates.io/crates/typeid/1.0.3 | desktop |
| typenum | 1.20.1 | see crate | https://crates.io/crates/typenum/1.20.1 | daemon, desktop |
| uds_windows | 1.2.1 | see crate | https://crates.io/crates/uds_windows/1.2.1 | desktop |
| unicode-ident | 1.0.27 | see crate | https://crates.io/crates/unicode-ident/1.0.27 | daemon, desktop |
| unicode-segmentation | 1.13.3 | see crate | https://crates.io/crates/unicode-segmentation/1.13.3 | desktop |
| untrusted | 0.9.0 | see crate | https://crates.io/crates/untrusted/0.9.0 | daemon, desktop |
| ureq | 2.12.1 | see crate | https://crates.io/crates/ureq/2.12.1 | desktop |
| url | 2.5.8 | see crate | https://crates.io/crates/url/2.5.8 | desktop |
| urlpattern | 0.6.0 | see crate | https://crates.io/crates/urlpattern/0.6.0 | desktop |
| utf-8 | 0.7.6 | see crate | https://crates.io/crates/utf-8/0.7.6 | daemon |
| utf8_iter | 1.0.4 | see crate | https://crates.io/crates/utf8_iter/1.0.4 | desktop |
| uuid | 1.28.0 | see crate | https://crates.io/crates/uuid/1.28.0 | desktop |
| version_check | 0.9.5 | see crate | https://crates.io/crates/version_check/0.9.5 | daemon, desktop |
| version-compare | 0.2.1 | see crate | https://crates.io/crates/version-compare/0.2.1 | desktop |
| vswhom | 0.1.0 | see crate | https://crates.io/crates/vswhom/0.1.0 | desktop |
| vswhom-sys | 0.1.3 | see crate | https://crates.io/crates/vswhom-sys/0.1.3 | desktop |
| walkdir | 2.5.0 | see crate | https://crates.io/crates/walkdir/2.5.0 | daemon, desktop |
| want | 0.3.2 | see crate | https://crates.io/crates/want/0.3.2 | desktop |
| wasi | 0.11.1+wasi-snapshot-preview1 | see crate | https://crates.io/crates/wasi/0.11.1+wasi-snapshot-preview1 | daemon, desktop |
| wasip2 | 1.0.4+wasi-0.2.12 | see crate | https://crates.io/crates/wasip2/1.0.4+wasi-0.2.12 | daemon, desktop |
| wasm-bindgen | 0.2.129 | see crate | https://crates.io/crates/wasm-bindgen/0.2.129 | desktop |
| wasm-bindgen-futures | 0.4.79 | see crate | https://crates.io/crates/wasm-bindgen-futures/0.4.79 | desktop |
| wasm-bindgen-macro | 0.2.129 | see crate | https://crates.io/crates/wasm-bindgen-macro/0.2.129 | desktop |
| wasm-bindgen-macro-support | 0.2.129 | see crate | https://crates.io/crates/wasm-bindgen-macro-support/0.2.129 | desktop |
| wasm-bindgen-shared | 0.2.129 | see crate | https://crates.io/crates/wasm-bindgen-shared/0.2.129 | desktop |
| wasm-streams | 0.5.0 | see crate | https://crates.io/crates/wasm-streams/0.5.0 | desktop |
| web_atoms | 0.2.6 | see crate | https://crates.io/crates/web_atoms/0.2.6 | desktop |
| web-sys | 0.3.106 | see crate | https://crates.io/crates/web-sys/0.3.106 | desktop |
| web-time | 1.1.0 | see crate | https://crates.io/crates/web-time/1.1.0 | desktop |
| webkit2gtk | 2.0.2 | see crate | https://crates.io/crates/webkit2gtk/2.0.2 | desktop |
| webkit2gtk-sys | 2.0.2 | see crate | https://crates.io/crates/webkit2gtk-sys/2.0.2 | desktop |
| webpki-root-certs | 1.0.10 | see crate | https://crates.io/crates/webpki-root-certs/1.0.10 | desktop |
| webpki-roots | 0.26.11 | see crate | https://crates.io/crates/webpki-roots/0.26.11 | desktop |
| webpki-roots | 1.0.9 | see crate | https://crates.io/crates/webpki-roots/1.0.9 | daemon, desktop |
| webview2-com | 0.39.1 | see crate | https://crates.io/crates/webview2-com/0.39.1 | desktop |
| webview2-com-macros | 0.8.1 | see crate | https://crates.io/crates/webview2-com-macros/0.8.1 | desktop |
| webview2-com-sys | 0.39.1 | see crate | https://crates.io/crates/webview2-com-sys/0.39.1 | desktop |
| winapi | 0.3.9 | see crate | https://crates.io/crates/winapi/0.3.9 | desktop |
| winapi-i686-pc-windows-gnu | 0.4.0 | see crate | https://crates.io/crates/winapi-i686-pc-windows-gnu/0.4.0 | desktop |
| winapi-util | 0.1.11 | see crate | https://crates.io/crates/winapi-util/0.1.11 | daemon, desktop |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | see crate | https://crates.io/crates/winapi-x86_64-pc-windows-gnu/0.4.0 | desktop |
| window-vibrancy | 0.8.1 | see crate | https://crates.io/crates/window-vibrancy/0.8.1 | desktop |
| windows | 0.62.2 | see crate | https://crates.io/crates/windows/0.62.2 | desktop |
| windows_aarch64_gnullvm | 0.42.2 | see crate | https://crates.io/crates/windows_aarch64_gnullvm/0.42.2 | desktop |
| windows_aarch64_gnullvm | 0.52.6 | see crate | https://crates.io/crates/windows_aarch64_gnullvm/0.52.6 | daemon, desktop |
| windows_aarch64_msvc | 0.42.2 | see crate | https://crates.io/crates/windows_aarch64_msvc/0.42.2 | desktop |
| windows_aarch64_msvc | 0.52.6 | see crate | https://crates.io/crates/windows_aarch64_msvc/0.52.6 | daemon, desktop |
| windows_i686_gnu | 0.42.2 | see crate | https://crates.io/crates/windows_i686_gnu/0.42.2 | desktop |
| windows_i686_gnu | 0.52.6 | see crate | https://crates.io/crates/windows_i686_gnu/0.52.6 | daemon, desktop |
| windows_i686_gnullvm | 0.52.6 | see crate | https://crates.io/crates/windows_i686_gnullvm/0.52.6 | daemon, desktop |
| windows_i686_msvc | 0.42.2 | see crate | https://crates.io/crates/windows_i686_msvc/0.42.2 | desktop |
| windows_i686_msvc | 0.52.6 | see crate | https://crates.io/crates/windows_i686_msvc/0.52.6 | daemon, desktop |
| windows_x86_64_gnu | 0.42.2 | see crate | https://crates.io/crates/windows_x86_64_gnu/0.42.2 | desktop |
| windows_x86_64_gnu | 0.52.6 | see crate | https://crates.io/crates/windows_x86_64_gnu/0.52.6 | daemon, desktop |
| windows_x86_64_gnullvm | 0.42.2 | see crate | https://crates.io/crates/windows_x86_64_gnullvm/0.42.2 | desktop |
| windows_x86_64_gnullvm | 0.52.6 | see crate | https://crates.io/crates/windows_x86_64_gnullvm/0.52.6 | daemon, desktop |
| windows_x86_64_msvc | 0.42.2 | see crate | https://crates.io/crates/windows_x86_64_msvc/0.42.2 | desktop |
| windows_x86_64_msvc | 0.52.6 | see crate | https://crates.io/crates/windows_x86_64_msvc/0.52.6 | daemon, desktop |
| windows-collections | 0.3.2 | see crate | https://crates.io/crates/windows-collections/0.3.2 | desktop |
| windows-core | 0.62.2 | see crate | https://crates.io/crates/windows-core/0.62.2 | desktop |
| windows-future | 0.3.2 | see crate | https://crates.io/crates/windows-future/0.3.2 | desktop |
| windows-implement | 0.60.2 | see crate | https://crates.io/crates/windows-implement/0.60.2 | desktop |
| windows-interface | 0.59.3 | see crate | https://crates.io/crates/windows-interface/0.59.3 | desktop |
| windows-link | 0.2.1 | see crate | https://crates.io/crates/windows-link/0.2.1 | daemon, desktop |
| windows-numerics | 0.3.1 | see crate | https://crates.io/crates/windows-numerics/0.3.1 | desktop |
| windows-registry | 0.6.1 | see crate | https://crates.io/crates/windows-registry/0.6.1 | desktop |
| windows-result | 0.4.1 | see crate | https://crates.io/crates/windows-result/0.4.1 | desktop |
| windows-strings | 0.5.1 | see crate | https://crates.io/crates/windows-strings/0.5.1 | desktop |
| windows-sys | 0.45.0 | see crate | https://crates.io/crates/windows-sys/0.45.0 | desktop |
| windows-sys | 0.52.0 | see crate | https://crates.io/crates/windows-sys/0.52.0 | daemon, desktop |
| windows-sys | 0.59.0 | see crate | https://crates.io/crates/windows-sys/0.59.0 | daemon, desktop |
| windows-sys | 0.61.2 | see crate | https://crates.io/crates/windows-sys/0.61.2 | daemon, desktop |
| windows-targets | 0.42.2 | see crate | https://crates.io/crates/windows-targets/0.42.2 | desktop |
| windows-targets | 0.52.6 | see crate | https://crates.io/crates/windows-targets/0.52.6 | daemon, desktop |
| windows-threading | 0.2.1 | see crate | https://crates.io/crates/windows-threading/0.2.1 | desktop |
| windows-version | 0.1.7 | see crate | https://crates.io/crates/windows-version/0.1.7 | desktop |
| winnow | 0.5.40 | see crate | https://crates.io/crates/winnow/0.5.40 | desktop |
| winnow | 1.0.4 | see crate | https://crates.io/crates/winnow/1.0.4 | desktop |
| winreg | 0.56.0 | see crate | https://crates.io/crates/winreg/0.56.0 | desktop |
| wit-bindgen | 0.57.1 | see crate | https://crates.io/crates/wit-bindgen/0.57.1 | daemon, desktop |
| writeable | 0.6.4 | see crate | https://crates.io/crates/writeable/0.6.4 | desktop |
| wry | 0.57.0 | see crate | https://crates.io/crates/wry/0.57.0 | desktop |
| x11 | 2.21.0 | see crate | https://crates.io/crates/x11/2.21.0 | desktop |
| x11-dl | 2.21.0 | see crate | https://crates.io/crates/x11-dl/2.21.0 | desktop |
| x11rb | 0.13.2 | see crate | https://crates.io/crates/x11rb/0.13.2 | desktop |
| x11rb-protocol | 0.13.2 | see crate | https://crates.io/crates/x11rb-protocol/0.13.2 | desktop |
| xattr | 1.6.1 | see crate | https://crates.io/crates/xattr/1.6.1 | desktop |
| xkeysym | 0.2.1 | see crate | https://crates.io/crates/xkeysym/0.2.1 | desktop |
| yoke | 0.8.3 | see crate | https://crates.io/crates/yoke/0.8.3 | desktop |
| yoke-derive | 0.8.4 | see crate | https://crates.io/crates/yoke-derive/0.8.4 | desktop |
| zbus | 5.19.0 | see crate | https://crates.io/crates/zbus/5.19.0 | desktop |
| zbus_macros | 5.19.0 | see crate | https://crates.io/crates/zbus_macros/5.19.0 | desktop |
| zbus_names | 4.3.4 | see crate | https://crates.io/crates/zbus_names/4.3.4 | desktop |
| zcheapstr | 1.1.0 | see crate | https://crates.io/crates/zcheapstr/1.1.0 | desktop |
| zerocopy | 0.8.63 | see crate | https://crates.io/crates/zerocopy/0.8.63 | daemon, desktop |
| zerocopy-derive | 0.8.63 | see crate | https://crates.io/crates/zerocopy-derive/0.8.63 | daemon, desktop |
| zerofrom | 0.1.8 | see crate | https://crates.io/crates/zerofrom/0.1.8 | desktop |
| zerofrom-derive | 0.1.8 | see crate | https://crates.io/crates/zerofrom-derive/0.1.8 | desktop |
| zeroize | 1.9.1 | see crate | https://crates.io/crates/zeroize/1.9.1 | daemon, desktop |
| zerotrie | 0.2.5 | see crate | https://crates.io/crates/zerotrie/0.2.5 | desktop |
| zerovec | 0.11.8 | see crate | https://crates.io/crates/zerovec/0.11.8 | desktop |
| zerovec-derive | 0.11.6 | see crate | https://crates.io/crates/zerovec-derive/0.11.6 | desktop |
| zip | 4.6.1 | see crate | https://crates.io/crates/zip/4.6.1 | desktop |
| zlib-rs | 0.6.8 | see crate | https://crates.io/crates/zlib-rs/0.6.8 | desktop |
| zmij | 1.0.23 | see crate | https://crates.io/crates/zmij/1.0.23 | daemon, desktop |
| zvariant | 5.15.0 | see crate | https://crates.io/crates/zvariant/5.15.0 | desktop |
| zvariant_derive | 5.15.0 | see crate | https://crates.io/crates/zvariant_derive/5.15.0 | desktop |
| zvariant_utils | 4.2.0 | see crate | https://crates.io/crates/zvariant_utils/4.2.0 | desktop |

## Android libraries (18)

Direct dependencies of `packages/android` (`app` and `client` modules), from `gradle/libs.versions.toml`. Test-only libraries are not listed.

| Library | Version | License | URL |
|---|---|---|---|
| org.jetbrains.kotlin:kotlin-stdlib | 2.4.21 | Apache-2.0 (from maintainer docs, not read from artifact) | https://github.com/JetBrains/kotlin |
| org.jetbrains.kotlinx:kotlinx-coroutines-core / -android | 1.11.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://github.com/Kotlin/kotlinx.coroutines |
| org.jetbrains.kotlinx:kotlinx-serialization-json | 1.11.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://github.com/Kotlin/kotlinx.serialization |
| com.squareup.okhttp3:okhttp | 5.5.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://github.com/square/okhttp |
| androidx.core:core-ktx | 1.19.1 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.activity:activity-compose | 1.13.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.fragment:fragment-ktx | 1.9.1 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.appcompat:appcompat | 1.8.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.navigation:navigation-compose | 2.10.2 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.lifecycle:lifecycle-viewmodel-compose / lifecycle-runtime-compose | 2.11.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.datastore:datastore-preferences | 1.2.1 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.biometric:biometric | 1.1.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.work:work-runtime-ktx | 2.12.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.camera:camera-core / camera2 / lifecycle / view | 1.6.2 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/androidx |
| androidx.compose (BOM): ui, ui-graphics, ui-tooling-preview, foundation, material3, material-icons-extended | BOM 2026.09.00 | Apache-2.0 (from maintainer docs, not read from artifact) | https://developer.android.com/jetpack/compose |
| com.google.crypto.tink:tink-android | 1.23.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://github.com/tink-crypto/tink-java |
| com.mikepenz:multiplatform-markdown-renderer-m3 / -code | 0.46.0 | Apache-2.0 (from maintainer docs, not read from artifact) | https://github.com/mikepenz/multiplatform-markdown-renderer |
| com.google.mlkit:barcode-scanning | 17.3.0 | Proprietary: ML Kit Terms of Service (not open source) | https://developers.google.com/ml-kit/terms |
