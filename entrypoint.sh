#!/bin/sh
# First start: detect the gateway's version, build the renderer at that
# exact tag, then serve. Nothing needs to be known or passed except GATEWAY.
# Mount a volume at /srv to skip the rebuild on restarts.
set -eu
: "${GATEWAY:=127.0.0.1:9119}"
: "${PORT:=8090}"

if [ ! -f /srv/index.html ]; then
  VERSION=$(curl -sf --max-time 10 "http://$GATEWAY/api/health" \
    | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  [ -n "$VERSION" ] || {
    echo "ERROR: could not read a version from http://$GATEWAY/api/health"
    echo "       (needed once, at first start, to match the renderer to the gateway)"
    exit 1
  }
  echo "== first start: building renderer at v$VERSION (a few minutes) =="
  mkdir -p /tmp/src && cd /tmp/src
  cp /app/build-renderer.mjs /app/web-bridge.js ./
  git clone --no-checkout --filter=blob:none https://github.com/NousResearch/hermes-agent src-upstream
  git -C src-upstream sparse-checkout init --cone
  git -C src-upstream sparse-checkout set apps/desktop apps/shared
  git -C src-upstream checkout "v$VERSION"
  # --ignore-scripts: the renderer build needs no postinstalls, and the ones
  # that would run (node-pty native compile, electron/playwright downloads)
  # are all things a browser bundle never uses.
  (cd src-upstream && npm ci --no-audit --no-fund --ignore-scripts)
  node build-renderer.mjs
  mkdir -p /srv && cp -r dist/* /srv/
  cd / && rm -rf /tmp/src
fi

# Render the nginx config with the gateway address + port.
sed -e "s|\${GATEWAY}|$GATEWAY|g" -e "s/listen 8090;/listen $PORT;/" \
  /app/nginx.conf.template > /etc/nginx/http.d/default.conf
exec nginx -g 'daemon off;'
