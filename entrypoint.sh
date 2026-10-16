#!/bin/sh
# First start: detect the gateway's version, build the renderer at that
# exact tag, then serve. Nothing needs to be known or passed except GATEWAY.
# Mount a volume at /srv to skip the rebuild on restarts.
set -eu
: "${GATEWAY:=127.0.0.1:9119}"
: "${PORT:=8090}"

# Fail fast if the port is taken — before spending minutes on a build.
if command -v httpd >/dev/null 2>&1; then
  rc=0
  timeout 1 httpd -p "$PORT" -f >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 124 ] || {
    echo "ERROR: port $PORT is already in use on this host."
    echo "       Use another one:  podman run ... -e PORT=8091 hermes-desktop-web"
    exit 1
  }
fi

if [ ! -f /srv/index.html ]; then
  echo "== looking for the Hermes backend at $GATEWAY =="
  VERSION=""
  for i in 1 2 3 4 5; do
    HEALTH=$(curl -sf --max-time 10 "http://$GATEWAY/api/health" 2>/dev/null || true)
    VERSION=$(printf '%s' "$HEALTH" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    [ -n "$VERSION" ] && break
    echo "   attempt $i/5: no answer from http://$GATEWAY — retrying in 5s"
    sleep 5
  done
  [ -n "$VERSION" ] || {
    echo "ERROR: no Hermes backend found at http://$GATEWAY"
    echo "       - is it running? (default: 127.0.0.1:9119)"
    echo "       - different address? pass it in:  -e GATEWAY=host:port"
    echo "       - same machine? the container must be able to reach that"
    echo "         address (e.g. --network host, or a routable host:port)."
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
