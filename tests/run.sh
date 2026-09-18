#!/usr/bin/env bash
# Run the headless registration tests.
#
# Uses JavaScriptCore, which ships with macOS, so there is no toolchain to
# install. Node works too if it happens to be present.
set -euo pipefail
cd "$(dirname "$0")/.."

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc

if [ -x "$JSC" ]; then
  exec "$JSC" --module-file=tests/registration.test.mjs
elif command -v node >/dev/null 2>&1; then
  exec node --input-type=module -e "globalThis.print=console.log; await import('./tests/registration.test.mjs');"
else
  echo "error: no JavaScript engine found (expected JavaScriptCore or node)" >&2
  exit 1
fi
