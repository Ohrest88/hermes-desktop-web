# hermes-desktop-web

Run the [Hermes Agent](https://hermes-agent.nousresearch.com) **desktop app UI in a
plain browser tab**, served from its own container, talking to a remote Hermes
gateway. No Electron on the client. No screen forwarding. No VNC. No reimplementation.

```
browser ──► nginx container :8090 ──┬── static bundle (the real desktop renderer)
                                    └── proxy /api /login /auth ──► hermes gateway :9119
```

## What this is

A thin browser shim for the Hermes desktop app. It builds the **unmodified
upstream renderer** with plain `vite build` and injects one file,
`web-bridge.js`, that implements the desktop app's Electron bridge
(`window.hermesDesktop`) over `fetch` + `WebSocket`. The result is the actual
desktop UI — same bundle, same look, same behavior — loading in a browser tab
and connecting to a Hermes gateway over the network, the same way the desktop
app's own "remote backend" mode does.

Not a fork. Not a rewrite. Zero upstream source files are modified.

## Why

The Hermes desktop app ships only as an Electron build, and the Linux build is
disabled upstream (the AppImage PRs, e.g. #86397 / #82859, never landed). But
the app is architecturally almost ready for the browser already:

- the renderer is a plain React app, and
- everything it does against a backend is already HTTP + WebSocket to the
  gateway — that path is network-native and needs no Electron.

The single weld holding the UI to Electron is `window.hermesDesktop`, a bridge
object (~50 methods) that Electron's preload script injects. Replace that one
object with a browser implementation and the app runs as a web app. That is the
whole trick.

Use cases this unlocks:

- **Any machine is a client** — phone, tablet, a random laptop — pointed at
  your always-on Hermes box (e.g. over Tailscale).
- **One gateway, many front-ends** — the web pod is stateless; the gateway
  holds all state.
- **Cheap to keep current** — because nothing is forked, updating means:
  check out the gateway's version tag, rerun the build. No merge conflicts,
  ever.

## How it works

The desktop renderer talks to the world exclusively through
`window.hermesDesktop`. `web-bridge.js` implements the same object against the
**same origin**:

- method calls → `fetch` to the gateway's REST API
- live updates → the gateway's own WebSocket flow (session cookie, then a
  single-use ticket from `POST /api/auth/ws-ticket`, then upgrade to `/api/ws`)
- desktop-only affordances (native dialogs, popout windows, updater, HUD) →
  safe no-op shapes via a fallback Proxy

A small nginx container serves the bundle and proxies `/api`, `/login`,
`/auth` to the gateway, so the browser sees one origin and the gateway's own
auth gate (login page, cookies, WS tickets) works completely untouched.

## Files

| File | Role |
|---|---|
| `web-bridge.js` | **the entire custom code** (~310 lines): browser implementation of `window.hermesDesktop`, including the Terminal tab wiring |
| `gateway-plugin/web-terminal/` | optional dashboard plugin for the gateway: WS endpoint that spawns a shell PTY (see Terminal tab section) |
| `build-renderer.mjs` | vite build of the upstream renderer, skipping Electron packaging; copies the bridge into `dist/` and injects it into `index.html` |
| `nginx.conf.template` | static + proxy config (`GATEWAY`/`PORT` substituted at start) |
| `Dockerfile` | node+nginx image; the build happens inside it at first start |
| `entrypoint.sh` | first-start logic: detect gateway version → clone → build → serve |
| `serve-test.py` | dev-only stdlib stand-in for nginx (used during development) |
| `start-relay.sh` | restart the dev relay after a container restart |
| `src-upstream/` | hermes-agent checkout (renderer source; **not committed**) |
| `dist/` | build output (generated; **not committed**) |

## Setup

You need **podman or docker** and a running Hermes gateway. Two commands,
no arguments, no scripts on your machine:

```bash
git clone https://github.com/Ohrest88/hermes-desktop-web && cd hermes-desktop-web
podman build -t hermes-desktop-web .
podman run -d --name hermes-desktop-web --network host hermes-desktop-web
# → http://127.0.0.1:8090   (first start takes a few minutes — see below)
```

The container does the rest on its own: on first start it reads your
gateway's version from `/api/health`, clones hermes-agent at exactly that
tag (the renderer↔gateway protocol must match), builds the bundle, and
serves it. Point it at a different gateway with `-e GATEWAY=host:port`
(default `127.0.0.1:9119`) and a different port with `-e PORT=`. Add
`-v hermes-web-srv:/srv` to keep the build across container restarts.

Sign in with the gateway's dashboard credentials (the same login as the
Hermes web dashboard).

<details>
<summary>Building without Docker (manual)</summary>

Needs node 22.22+/24.11+/26 and npm:

```bash
git clone --no-checkout --filter=blob:none https://github.com/NousResearch/hermes-agent src-upstream
git -C src-upstream sparse-checkout init --cone
git -C src-upstream sparse-checkout set apps/desktop apps/shared
git -C src-upstream checkout v0.21.6        # ← must equal the gateway's version
cd src-upstream && npm ci --no-audit --no-fund && cd ..
node build-renderer.mjs                     # → dist/
# then serve dist/ with any static host + the /api,/login,/auth proxy from
# nginx.conf.template
```
</details>

## Status

Verified end-to-end against a live gateway (v0.21.6), including the full
container path on a real host: `podman build` + first start → version
detect → clone → npm ci → vite build → nginx serves → login → session
sidebar → send a message → agent turn streams over the gateway WebSocket.
Settings (all pages), Capabilities, Messaging, Artifacts, Scheduled jobs,
and sidebar toggles render with zero console errors.

## Terminal tab

The desktop app's Terminal tab opens a shell wherever Hermes runs: a local
PTY when the gateway is local, `ssh -tt` to the gateway's host when it's
remote. A browser can do neither — so this repo ships the gateway-side half
of that contract: `gateway-plugin/web-terminal/`, a small Hermes dashboard
plugin that adds one WebSocket endpoint. When you open the Terminal tab,
the gateway spawns `$SHELL` in a PTY (via Hermes' own `PtyBridge`, the same
one the official dashboard's embedded chat terminal uses) and streams bytes
to the browser's xterm.js.

- Auth is the gateway's canonical dashboard WebSocket gate (session
  cookie or single-use ticket). No new auth surface, no SSH.
- Resize rides the dashboard's `ESC[RESIZE:cols;rows]` input escape.

Install it on the machine where Hermes runs — one command, from this repo,
using Hermes' own plugin installer (it knows where its plugins directory
lives; no paths to figure out):

```bash
hermes plugins install Ohrest88/hermes-desktop-web#gateway-plugin/web-terminal --enable
```

(`#…` selects the plugin's subdirectory. A running dashboard hot-mounts
plugin routes — restart the gateway only if it doesn't.)

<details>
<summary>Without GitHub (running from a local checkout)</summary>

```bash
cp -r gateway-plugin/web-terminal "$(hermes config path | xargs dirname)/plugins/"
hermes plugins enable web-terminal
```

</details>

Without the plugin, everything else works; the Terminal tab reports the
gateway terminal as unreachable.

This is upstream's own plan, not a fork: the desktop source contains
`NOTE(remote-terminal)` — the SSH terminal path is "interim until the
dashboard `/api/terminal` WebSocket lands". This plugin is that landing
zone; when upstream ships it, delete this plugin and point the shim at
the official endpoint.

## Known limits (web mode)

- **Native-only features no-op:** OS window management, popout windows, HUD,
  pet overlays, in-app updater. (File attach uses the browser's native
  file picker via the shim.)
- **Single connection:** the gateway this origin proxies to. The desktop's
  multi-backend connection registry is Electron-side and not reimplemented.
- **Version lock:** build the renderer at the gateway's version tag. The
  desktop↔gateway protocol has versioned expectations; a mismatched renderer
  stalls at boot.
- **Session TTL:** the gateway's dashboard cookie expires (~15 min), so the
  web app bounces to `/login` periodically.
- **Mic/voice** needs a secure context (https or localhost).

## License

MIT, matching hermes-agent (see `src-upstream/LICENSE`). `web-bridge.js` and
the scripts in this repo: MIT. The renderer bundle in `dist/` is built from
hermes-agent sources under the same MIT license.
