// Build ONLY the desktop renderer (static web bundle) with plain vite —
// skipping electron-main bundling, native deps, and install stamps.
// Mirrors compileRenderer() in scripts/build/desktop.mjs in the upstream repo.
// Run from this repo root after setting up src-upstream/ (see README).
import { cpSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const root = import.meta.dirname
const source = join(root, 'src-upstream')
const app = join(source, 'apps/desktop')
const out = join(root, 'dist')
const publicDir = join(root, 'build-public')

if (!existsSync(app)) {
  console.error('src-upstream/apps/desktop missing — run the clone steps in README.md first.')
  process.exit(1)
}

// node_modules lives in src-upstream; resolve vite from there.
// Babel resolves plugins relative to process.cwd(), so build from inside the checkout.
process.chdir(source)
const vite = createRequire(join(source, 'package.json')).resolve('vite')
const { build: viteBuild } = await import(`file://${vite}`)

if (existsSync(publicDir)) rmSync(publicDir, { recursive: true }) // fresh copy so icon stamps don't leak
cpSync(join(app, 'public'), publicDir, { recursive: true })

await viteBuild({
  root: app,
  configLoader: 'runner',
  publicDir,
  cacheDir: join(root, 'vite-cache'),
  build: { outDir: out, emptyOutDir: true },
})

// Inject the bridge: copy it in and load it BEFORE the app bundle,
// so window.hermesDesktop exists when the renderer's first line runs.
cpSync(join(root, 'web-bridge.js'), join(out, 'web-bridge.js'))
const index = join(out, 'index.html')
const html = readFileSync(index, 'utf8')
if (!html.includes('web-bridge.js')) {
  writeFileSync(index, html.replace('</head>', '  <script src="./web-bridge.js"></script>\n  </head>'))
}
console.log('renderer build done ->', out)
