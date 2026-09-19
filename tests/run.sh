#!/usr/bin/env bash
# Run the headless unit tests: registration math, and capture deletion.
#
# Uses JavaScriptCore, which ships with macOS, so there is no toolchain to
# install. Node works too if it happens to be present.
set -euo pipefail
cd "$(dirname "$0")/.."

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc

run() {
  if [ -x "$JSC" ]; then
    "$JSC" --module-file="$1"
  else
    node --input-type=module -e "globalThis.print=console.log; await import('./$1');"
  fi
}

if [ -x "$JSC" ] || command -v node >/dev/null 2>&1; then
  status=0
  for t in tests/registration.test.mjs tests/periodic.test.mjs tests/recording.test.mjs; do
    echo "== $t"
    run "$t" || status=1
  done
  exit "$status"
else
  echo "error: no JavaScript engine found (expected JavaScriptCore or node)" >&2
  exit 1
fi
