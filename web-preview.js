// Hermes Desktop Web - <webview> for browsers.
//
// The Electron renderer builds its preview pane around the <webview> tag.
// Browsers have no such element, so we register one: a custom element that
// shows a live stream of a tab in the server-side preview Chromium (relay.py)
// and forwards input, navigation and script calls over one WebSocket. The
// method names, events and event fields are the ones preview-pane.tsx reads,
// so the renderer needs no change.
//
// Loaded by index.html before the renderer bundle (entrypoint.sh injects the tag).

;(() => {
  if (typeof window === 'undefined' || window.__hermesWebPreview) return
  window.__hermesWebPreview = true

  const RELAY_PATH = '/preview-ws'

  // "webview" is not a legal custom-element name (no hyphen), so we cannot
  // customElements.define it. Instead we watch the DOM for <webview> tags the
  // renderer creates and upgrade each one in place by swapping its prototype.
  class WebView extends HTMLElement {
    static adopt(el) {
      if (el.__hermesPreview) return
      el.__hermesPreview = true
      Object.setPrototypeOf(el, WebView.prototype)
      el._init()
      el._attach()
    }

    _init() {
      this._ws = null
      this._seq = 0
      this._pending = new Map()
      this._url = ''
      this._title = ''
      this._canBack = false
      this._canFwd = false
      this._ready = false
      this._queue = []
      this._webContentsId = 0
      this._zoom = 1
      this._lastSize = ''
      this._scale = Math.min(2, window.devicePixelRatio || 1)

      this._img = document.createElement('img')
      this._img.draggable = false
      this._img.alt = ''
      this._img.style.cssText =
        'display:block;width:100%;height:100%;object-fit:fill;user-select:none;-webkit-user-drag:none;cursor:default;outline:none;background:#fff'
      this._img.tabIndex = 0
      this._attrObs = new MutationObserver(ms => {
        for (const m of ms) if (m.attributeName === 'src') this._onSrc(this.getAttribute('src'))
      })
    }

    _attach() {
      if (!this.style.display) this.style.display = 'block'
      if (!this._img.isConnected) this.appendChild(this._img)
      this._bindInput()
      this._ro = new ResizeObserver(() => this._syncSize())
      this._ro.observe(this)
      this._attrObs.observe(this, { attributes: true, attributeFilter: ['src'] })
      this._connect()
    }

    _detach() {
      this._ro?.disconnect()
      this._attrObs?.disconnect()
      this._close()
    }

    _onSrc(value) {
      if (value) this._send({ op: 'navigate', url: value })
    }

    // ---- transport -------------------------------------------------------
    _connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      // Each profile window loads with ?profile=<name>; the relay keeps a
      // separate browser (cookies, logins, storage) per profile.
      const profile = new URLSearchParams(location.search).get('profile') || 'default'
      const ws = new WebSocket(`${proto}//${location.host}${RELAY_PATH}?profile=${encodeURIComponent(profile)}`)
      this._ws = ws
      ws.onopen = () => {}
      ws.onmessage = ev => this._onMessage(JSON.parse(ev.data))
      ws.onerror = () => {}
      ws.onclose = ev => {
        this._ready = false
        for (const [, p] of this._pending) p.reject(new Error('preview relay closed'))
        this._pending.clear()
        if (this.isConnected) {
          this._emit('did-fail-load', {
            errorCode: -2, isMainFrame: true, validatedURL: this._url,
            errorDescription: ev.code === 1013 ? 'Too many preview panes open' : 'Preview browser unavailable'
          })
        }
      }
    }

    _close() {
      const ws = this._ws
      this._ws = null
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
    }

    _send(msg) {
      if (!this._ready) { this._queue.push(msg); return }
      this._ws?.send(JSON.stringify(msg))
    }

    _call(msg) {
      return new Promise((resolve, reject) => {
        const id = ++this._seq
        this._pending.set(id, { resolve, reject })
        this._send({ ...msg, id })
      })
    }

    _onMessage(m) {
      if (m.frame) {
        this._img.src = 'data:image/jpeg;base64,' + m.frame
        return
      }
      if (m.id !== undefined) {
        const p = this._pending.get(m.id)
        if (!p) return
        this._pending.delete(m.id)
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result ?? null)
        return
      }
      switch (m.event) {
        case 'ready': {
          this._ready = true
          this._webContentsId = m.webContentsId || 1
          this._syncSize(true)
          const q = this._queue; this._queue = []
          const src = this.getAttribute('src')
          if (src && !q.some(x => x.op === 'navigate')) q.unshift({ op: 'navigate', url: src })
          for (const x of q) this._ws?.send(JSON.stringify(x))
          return
        }
        case 'did-navigate':
        case 'did-navigate-in-page':
          if (m.url) this._url = m.url
          break
        case 'page-title-updated':
          this._title = m.title || ''
          break
        case 'history':
          this._canBack = !!m.canGoBack
          this._canFwd = !!m.canGoForward
          if (m.url) this._url = m.url
          return
      }
      const { event, ...detail } = m
      this._emit(event, detail)
    }

    _emit(name, detail) {
      const ev = new Event(name)
      Object.assign(ev, detail)
      this.dispatchEvent(ev)
    }

    _syncSize(force) {
      const r = this.getBoundingClientRect()
      const w = Math.round(r.width), h = Math.round(r.height)
      if (w < 50 || h < 50) return
      const key = `${w}x${h}@${this._scale}`
      if (!force && key === this._lastSize) return
      this._lastSize = key
      this._send({ op: 'resize', width: w, height: h, scale: this._scale })
    }

    // ---- input -----------------------------------------------------------
    _point(ev) {
      const r = this._img.getBoundingClientRect()
      return { x: Math.round(ev.clientX - r.left), y: Math.round(ev.clientY - r.top) }
    }

    _bindInput() {
      const img = this._img
      const mouse = (type, ev) => {
        const p = this._point(ev)
        const e = { type, ...p, button: 'left', clickCount: ev.detail || 1 }
        if (type === 'mouseMove') delete e.clickCount
        this.sendInputEvent(e)
      }
      img.addEventListener('pointerdown', ev => { img.focus(); mouse('mouseDown', ev); ev.preventDefault() })
      img.addEventListener('pointerup', ev => mouse('mouseUp', ev))
      img.addEventListener('pointermove', ev => { if (ev.buttons !== 2) mouse('mouseMove', ev) })
      img.addEventListener('contextmenu', ev => ev.preventDefault())
      img.addEventListener('wheel', ev => {
        const p = this._point(ev)
        this.sendInputEvent({ type: 'mouseWheel', ...p, deltaX: ev.deltaX, deltaY: ev.deltaY })
        ev.preventDefault()
      }, { passive: false })
      const mods = ev => ['alt', 'control', 'meta', 'shift'].filter(k => ev[k + 'Key'])
      // Keys typed in the pane belong to the page, not the chat composer
      // (the app focuses the composer on stray keystrokes).
      for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input']) {
        img.addEventListener(type, ev => ev.stopPropagation())
      }
      img.addEventListener('keydown', ev => {
        const printable = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey
        this._send({ op: 'input', event: { type: 'keyDown', key: ev.key, code: ev.code, keyCode: ev.key, vk: ev.keyCode, modifiers: mods(ev), text: printable ? ev.key : (ev.key === 'Enter' ? '\r' : undefined) } })
        if (!['F5', 'F11', 'F12'].includes(ev.key) && !(ev.metaKey || ev.ctrlKey) ) ev.preventDefault()
      })
      img.addEventListener('keyup', ev => {
        this._send({ op: 'input', event: { type: 'keyUp', key: ev.key, code: ev.code, keyCode: ev.key, vk: ev.keyCode, modifiers: mods(ev) } })
      })
      img.addEventListener('paste', ev => {
        const text = ev.clipboardData?.getData('text') || ''
        if (text) this._call({ op: 'eval', code: `(()=>{const a=document.activeElement;if(!a)return;const t=${JSON.stringify(text)};if('setRangeText' in a){a.setRangeText(t,a.selectionStart,a.selectionEnd,'end');a.dispatchEvent(new Event('input',{bubbles:true}))}else document.execCommand('insertText',false,t)})()` }).catch(() => {})
      })
    }

    // ---- Electron <webview> surface used by preview-pane.tsx -------------
    loadURL(url) { this._url = url; return this._call({ op: 'navigate', url }).then(() => undefined) }
    reload() { this._send({ op: 'reload' }) }
    reloadIgnoringCache() { this._send({ op: 'reload', ignoreCache: true }) }
    goBack() { this._send({ op: 'back' }) }
    goForward() { this._send({ op: 'forward' }) }
    canGoBack() { return this._canBack }
    canGoForward() { return this._canFwd }
    getURL() { return this._url }
    getTitle() { return this._title }
    getWebContentsId() { return this._webContentsId }
    getZoomFactor() { return this._zoom }
    executeJavaScript(code) { return this._call({ op: 'eval', code }) }
    sendInputEvent(event) {
      if (event && event.type === 'char') {
        this._send({ op: 'input', event })
        return
      }
      this._send({ op: 'input', event })
    }
    focus() { this._img.focus({ preventScroll: true }); this._send({ op: 'focus' }) }
    // No devtools / spellcheck / clipboard ops in web mode: honest no-ops.
    openDevTools() {}
    closeDevTools() {}
    isDevToolsOpened() { return false }
    inspectElement() {}
    replaceMisspelling() {}
    copy() { document.execCommand('copy') }
    cut() {}
    paste() {}
    selectAll() { this._call({ op: 'eval', code: 'document.execCommand("selectAll")' }).catch(() => {}) }
  }

  const scan = root => {
    if (root.nodeType !== 1) return
    if (root.tagName === 'WEBVIEW') WebView.adopt(root)
    for (const el of root.querySelectorAll('webview')) WebView.adopt(el)
  }
  const unscan = root => {
    if (root.nodeType !== 1) return
    if (root.__hermesPreview && !root.isConnected) root._detach()
    for (const el of root.querySelectorAll('webview')) if (el.__hermesPreview) el._detach()
  }
  new MutationObserver(ms => {
    for (const m of ms) {
      m.addedNodes.forEach(scan)
      m.removedNodes.forEach(unscan)
    }
  }).observe(document.documentElement, { childList: true, subtree: true })
  scan(document.documentElement)
})()
