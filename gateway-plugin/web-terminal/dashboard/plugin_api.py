"""web-terminal: gateway-side shell PTY for the Hermes Desktop web build.

Exposes one WebSocket — ``/api/plugins/web-terminal/terminal`` — that spawns
the gateway's login shell behind a PTY (the same ``PtyBridge`` the dashboard's
own ``/api/pty`` uses) and pumps raw bytes to/from an xterm.js client. This is
the web-mode equivalent of the desktop app's SSH-terminal path (see
apps/desktop/electron/ssh-connection.ts NOTE(remote-terminal)): the terminal
lives where Hermes lives.

Auth: the dashboard's canonical WS gate (``?ticket=`` / ``?token=``), the same
one ``/api/pty`` and the kanban event stream use — no new credential concept.
Resize rides the dashboard's existing escape: ``ESC[RESIZE:cols;rows]``.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status as http_status

router = APIRouter()

# Same resize escape the dashboard's xterm.js sends (web_server_chat._RESIZE_RE).
_RESIZE_RE = re.compile(rb"\x1b\[RESIZE:(\d+);(\d+)\]")


def _ws_auth_ok(ws) -> bool:
    """Delegate to the dashboard's canonical WS auth gate so this endpoint can
    never drift from core auth (mirrors plugins/kanban dashboard API)."""
    try:
        from hermes_cli import web_server_chat as _ws
    except Exception:
        return True
    return bool(_ws._ws_auth_ok(ws))


def _shell_argv() -> list[str]:
    shell = os.environ.get("SHELL") or shutil.which("bash") or shutil.which("sh") or "/bin/sh"
    return [shell, "-l"]


@router.get("/health")
async def health():
    from hermes_cli.pty_bridge import PtyBridge

    return {"ok": True, "pty_available": bool(PtyBridge.is_available())}


@router.get("/shell")
async def shell_info():
    """Preflight for the web bridge: which shell/cwd a terminal would get."""
    shell = _shell_argv()[0]
    return {"shell": os.path.basename(shell), "cwd": os.getcwd()}


@router.websocket("/terminal")
async def terminal_ws(ws: WebSocket) -> None:
    if not _ws_auth_ok(ws):
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return

    from hermes_cli.pty_bridge import PtyBridge, PtyUnavailableError

    try:
        cols = max(2, int(ws.query_params.get("cols") or 80))
        rows = max(2, int(ws.query_params.get("rows") or 24))
    except ValueError:
        cols, rows = 80, 24

    cwd = (ws.query_params.get("cwd") or "").strip() or None
    if cwd is not None and not os.path.isdir(cwd):
        cwd = None  # stale restore cwd: fall back to the server cwd, never fail the dial

    try:
        bridge = PtyBridge.spawn(_shell_argv(), cwd=cwd, cols=cols, rows=rows)
    except (PtyUnavailableError, FileNotFoundError, OSError) as exc:
        await ws.close(code=1011, reason=str(exc)[:120])
        return

    await ws.accept()

    async def pump_pty_to_ws() -> None:
        # bridge.read blocks up to the poll timeout in a worker thread; None = EOF.
        while True:
            data = await asyncio.to_thread(bridge.read, 0.2)
            if data is None:
                break
            if data:
                await ws.send_bytes(data)
        # Shell exited: close so the client fires its onExit (4410 mirrors /api/pty).
        try:
            await ws.close(code=4410, reason="shell exited")
        except Exception:
            pass

    pump = asyncio.create_task(pump_pty_to_ws())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is None:
                text = msg.get("text")
                if not text:
                    continue
                data = text.encode()
            if not data:
                continue
            # Resize escapes ride the input stream; strip them, forward the rest.
            match = _RESIZE_RE.search(data)
            if match:
                bridge.resize(int(match.group(1)), int(match.group(2)))
                data = data[: match.start()] + data[match.end() :]
                if not data:
                    continue
            await bridge.write(data)
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        bridge.close()
