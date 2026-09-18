#!/bin/bash
cd "$(dirname "$0")"
PORT=8765
echo "Longshot dev server"
echo "  app        http://localhost:$PORT/"
echo "  self-test  http://localhost:$PORT/tests/browser.html"
echo
open "http://localhost:$PORT/"
exec /usr/bin/python3 -m http.server $PORT
