#!/bin/sh
# Puts the Mac code-signing certificate into a temporary keychain for the
# release's macOS jobs, so every release is signed by the same identity and
# macOS keeps the app's and the daemon's privacy permissions across updates.
# The secrets MACOS_SIGNING_P12 (base64 .p12) and MACOS_SIGNING_P12_PASSWORD
# hold it (docs/INSTALL.md, section 14). With both, it sets
# APPLE_SIGNING_IDENTITY for tauri build (which wins over bundle.macOS
# signingIdentity) and MACOS_SIGN_IDENTITY for the daemon's codesign step.
# Without them (forks, builds by hand without secrets) it sets nothing and the
# app stays ad-hoc signed, as before.
#
# Tauri's own APPLE_CERTIFICATE import looks only for Apple certificate names,
# so this imports the self-signed certificate itself. codesign signs with it
# untrusted, so no trust setting is needed.
#   scripts/ci/macos-keychain.sh
set -eu
identity="Conclave Self-Signed Code Signing"
if [ -z "${MACOS_SIGNING_P12:-}" ] || [ -z "${MACOS_SIGNING_P12_PASSWORD:-}" ]; then
  echo "::notice::No MACOS_SIGNING_P12 secret: the Mac build is signed ad hoc, and macOS asks for its permissions again after the update."
  exit 0
fi
kc="$RUNNER_TEMP/conclave-signing.keychain-db"
p12="$RUNNER_TEMP/conclave-signing.p12"
kc_pass="$(openssl rand -hex 24)"
echo "::add-mask::$kc_pass"
printf '%s' "$MACOS_SIGNING_P12" | base64 --decode > "$p12"
security create-keychain -p "$kc_pass" "$kc"
security set-keychain-settings -lut 21600 "$kc"
security unlock-keychain -p "$kc_pass" "$kc"
security import "$p12" -k "$kc" -f pkcs12 -P "$MACOS_SIGNING_P12_PASSWORD" -T /usr/bin/codesign
rm -f "$p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kc_pass" "$kc" > /dev/null
# keep the runner's keychains in the search list, ours first
# shellcheck disable=SC2046
security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
# no -v: a self-signed certificate is not trusted, and -v hides it
security find-identity -p codesigning "$kc" | grep -F "\"$identity\""
echo "APPLE_SIGNING_IDENTITY=$identity" >> "$GITHUB_ENV"
echo "MACOS_SIGN_IDENTITY=$identity" >> "$GITHUB_ENV"
