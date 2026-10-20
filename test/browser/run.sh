#!/bin/sh
# The browser tests: replays, surrender, spectating and chat, in headless Chromium.
# Needs Node and, once:   npm i --no-save playwright && npx playwright install chromium
# (or point CHROMIUM at a Chromium binary), and three.js 0.158.0 next to this
# script as three.min.js (npm pack three@0.158.0; it's package/build/three.min.js),
# or its path in THREE_JS. Build first: ./build.sh
set -e
cd "$(dirname "$0")"
PORT=8787 node ../../server.js > /dev/null & RELAY=$!
node serve.cjs ../../dist/vibecraft.html > /dev/null & SERVE=$!
trap 'kill $RELAY $SERVE' EXIT
sleep 1
status=0
for t in replay spectate-single spectate-online chat; do
  echo "== $t"
  node $t.mjs || status=1
done
exit $status
