#!/usr/bin/env bash
# Start the dev relay (static bundle + gateway proxy) on 0.0.0.0:8090.
# Run this inside the hermes2 container after every container restart.
cd "$(dirname "$0")"
pkill -f serve-test.py 2>/dev/null || true
sleep 0.5
nohup python3 serve-test.py >/tmp/hermes-web-relay.log 2>&1 &
sleep 1
if curl -sf -o /dev/null http://127.0.0.1:8090/ --max-time 3; then
  echo "relay up on :8090"
else
  echo "relay FAILED:"; tail -5 /tmp/hermes-web-relay.log; exit 1
fi
