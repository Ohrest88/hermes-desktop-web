#!/usr/bin/env python3
"""Test stand-in for the nginx pod: static /srv files + /api,/login,/auth
reverse proxy to the gateway, with WebSocket upgrade passthrough.
Mirrors nginx.conf.template semantics for local validation."""
import http.server, socket, socketserver, threading, sys, os

GATEWAY = ('127.0.0.1', int(os.environ.get('GATEWAY_PORT', '9119')))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')
PORT = int(os.environ.get('PORT', '8090'))
PROXY_PREFIXES = ('/api', '/login', '/auth')

def relay(a, b):
    try:
        while (chunk := a.recv(65536)):
            b.sendall(chunk)
    except OSError:
        pass
    try: b.shutdown(socket.SHUT_WR)
    except OSError: pass

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def proxy(self):
        try:
            up = socket.create_connection(GATEWAY)
        except OSError as e:
            self.send_error(502, str(e)); return
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        head = f'{self.command} {self.path} HTTP/1.1\r\n'.encode()
        for k, v in self.headers.items():
            if k.lower() == 'host': v = f'{GATEWAY[0]}:{GATEWAY[1]}'
            head += f'{k}: {v}\r\n'.encode()
        head += b'X-Forwarded-Prefix: \r\n'
        up.sendall(head + b'\r\n' + body)
        is_ws = self.headers.get('Upgrade', '').lower() == 'websocket'
        if not is_ws:
            # Buffer non-WS responses fully (small JSON), keep connection alive.
            resp = b''
            up.settimeout(30)
            try:
                while chunk := up.recv(65536):
                    resp += chunk
                    if b'\r\n\r\n' in resp:
                        hdr, _, rest = resp.partition(b'\r\n\r\n')
                        cl = next((int(v) for k, v in [h.split(':', 1) for h in hdr.decode('latin1').split('\r\n')[1:] if ':' in h] if k.strip().lower() == 'content-length'), None)
                        if cl is not None and len(rest) >= cl: break
                        if cl is None and b'chunked' not in hdr.decode('latin1'): break
            except OSError:
                pass
            up.close()
            self.send_response(200 if not resp else None) if False else None
            # Re-emit status line + headers verbatim:
            if resp:
                hdr, _, rest = resp.partition(b'\r\n\r\n')
                lines = hdr.decode('latin1').split('\r\n')
                self.send_response_only(int(lines[0].split(' ')[1]))
                for line in lines[1:]:
                    k, _, v = line.partition(':')
                    if k.strip().lower() in ('transfer-encoding',): continue
                    self.send_header(k.strip(), v.strip())
                self.send_header('Content-Length', str(len(rest)))
                self.end_headers()
                self.wfile.write(rest)
            else:
                self.send_error(502, 'empty gateway response')
            return
        # WebSocket: request was already forwarded in `head`; read the
        # gateway's 101 handshake back and splice the raw streams.
        resp_head = b''
        up.settimeout(10)
        while b'\r\n\r\n' not in resp_head:
            b = up.recv(1)
            if not b: break
            resp_head += b
        self.wfile.write(resp_head)
        self.wfile.flush()
        up.settimeout(None)  # handshake done; raw splice must block forever
        # rfile is buffered: any WS frame bytes the client pipelined after the
        # upgrade request are sitting in the BufferedReader, not the socket.
        # Drain them to the gateway before raw splicing, or the first
        # JSON-RPC frame vanishes.
        try:
            pending = bytes(self.rfile._buffer)  # noqa: SLF001
            if pending:
                up.sendall(pending)
        except Exception:
            pass
        t1, t2 = threading.Thread(target=relay, args=(self.connection, up)), threading.Thread(target=relay, args=(up, self.connection))
        t1.daemon = t2.daemon = True; t1.start(); t2.start(); t1.join(); t2.join()

    def do_GET(self):
        if self.path.startswith(PROXY_PREFIXES): return self.proxy()
        return self.serve_static()

    def do_HEAD(self): return self.do_GET()

    def do_POST(self):
        if self.path.startswith(PROXY_PREFIXES): return self.proxy()
        self.send_error(405)

    def do_PATCH(self): return self.proxy() if self.path.startswith(PROXY_PREFIXES) else self.send_error(405)
    def do_PUT(self): return self.do_PATCH()
    def do_DELETE(self): return self.do_PATCH()

    def serve_static(self):
        path = self.path.split('?')[0]
        fpath = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
        if not fpath.startswith(ROOT) or not os.path.isfile(fpath):
            fpath = os.path.join(ROOT, 'index.html')
        ctype = ('text/html' if fpath.endswith('.html') else
                 'application/javascript' if fpath.endswith('.js') else
                 'text/css' if fpath.endswith('.css') else
                 'application/json' if fpath.endswith('.json') else
                 'image/png' if fpath.endswith('.png') else 'application/octet-stream')
        data = open(fpath, 'rb').read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a): pass

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == '__main__':
    print(f'serving {ROOT} on :{PORT}, proxy → {GATEWAY}')
    Server(('0.0.0.0', PORT), Handler).serve_forever()
