# Everything happens inside the container: first start detects the gateway's
# version, builds the renderer at that exact tag, then serves it.
# The host only ever runs two plain podman commands — no scripts, no args.
#
#   podman build -t hermes-desktop-web .
#   podman run -d --name hermes-desktop-web --network host hermes-desktop-web
#
# Env: GATEWAY=host:port (default 127.0.0.1:9119)   PORT=8090
# Tip: add -v hermes-web-srv:/srv to keep the build across container restarts.
FROM docker.io/library/node:26-alpine
RUN apk add --no-cache nginx git curl
COPY entrypoint.sh build-renderer.mjs web-bridge.js nginx.conf.template /app/
RUN chmod +x /app/entrypoint.sh
ENV GATEWAY=127.0.0.1:9119
EXPOSE 8090
ENTRYPOINT ["/app/entrypoint.sh"]
