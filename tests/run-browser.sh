#!/usr/bin/env bash
# Run the end-to-end browser test and report pass/fail on the command line.
#
# Serves the repo, drives a Chromium-family browser at tests/browser.html, and
# waits for the page to POST its results back. Any of Brave, Chrome, Chromium or
# Edge will do; set BROWSER to point at another one.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8791}"
HEADLESS="${HEADLESS:-1}"

if [ -z "${BROWSER:-}" ]; then
  for c in \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    [ -x "$c" ] && BROWSER="$c" && break
  done
fi
if [ -z "${BROWSER:-}" ]; then
  echo "error: no Chromium-family browser found; set BROWSER=/path/to/browser" >&2
  exit 1
fi

exec /usr/bin/python3 tests/harness.py "$PORT" "$BROWSER" "$HEADLESS"
