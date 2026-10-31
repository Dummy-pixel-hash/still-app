import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

assert.equal(process.platform, "linux", "This smoke test must run on Linux/WebKitGTK")
assert.ok(process.argv[2], "Pass the Linux executable or AppImage to test")
assert.equal(typeof WebSocket, "function", "Node 22+ WebSocket is required")

const executable = process.argv[2]
const port = await new Promise((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    server.close(error => error ? reject(error) : resolve(address.port))
  })
})
const app = spawn(executable, [], {
  env: { ...process.env, GDK_BACKEND: "x11", WEBKIT_INSPECTOR_HTTP_SERVER: `127.0.0.1:${port}` },
  stdio: "ignore",
})
let socket
let exitError
app.once("error", error => { exitError = error })
app.once("exit", (code, signal) => { exitError ||= new Error(`App exited before smoke test completed (code=${code}, signal=${signal})`) })

const timeout = (promise, ms, label) => Promise.race([
  promise,
  delay(ms).then(() => { throw new Error(`Timed out waiting for ${label}`) }),
])

try {
  const deadline = Date.now() + 20_000
  let listing
  while (Date.now() < deadline) {
    if (exitError) throw exitError
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) {
        listing = await response.text()
        if (/\/socket\/\d+\/\d+\/(?:WebPage|web-page)[^\'" ]*/i.test(listing)) break
      }
    } catch {}
    await delay(100)
  }
  assert.ok(listing, "WebKitGTK remote inspector did not start")
  const socketPath = listing.match(/\/socket\/\d+\/\d+\/(?:WebPage|web-page)[^\'" ]*/i)?.[0]
  assert.ok(socketPath, `WebKitGTK did not expose the main page target: ${listing?.slice(-400)}`)

  socket = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`)
  const targetId = await timeout(new Promise((resolve, reject) => {
    const onError = () => reject(new Error("Could not connect to the WebKitGTK inspector socket"))
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data))
      if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page") resolve(message.params.targetInfo.targetId)
    })
  }), 8_000, "main WebKit page target")

  let outerId = 0, commandId = 0
  const pending = new Map()
  socket.addEventListener("message", event => {
    const outer = JSON.parse(String(event.data))
    if (outer.method !== "Target.dispatchMessageFromTarget") return
    const inner = JSON.parse(outer.params.message)
    const resolve = pending.get(inner.id)
    if (!resolve) return
    pending.delete(inner.id)
    if (inner.error) resolve({ error: inner.error })
    else resolve({ value: inner.result?.result?.value ?? inner.result?.result })
  })
  const command = (method, params = {}) => timeout(new Promise(resolve => {
    const id = ++commandId
    pending.set(id, resolve)
    socket.send(JSON.stringify({
      id: ++outerId,
      method: "Target.sendMessageToTarget",
      params: { targetId, message: JSON.stringify({ id, method, params }) },
    }))
  }), 5_000, method)

  const enabled = await Promise.all([command("Runtime.enable"), command("Page.enable")])
  for (const result of enabled) assert.ok(!result.error, JSON.stringify(result.error))

  let opened = false
  const openBy = Date.now() + 10_000
  while (!opened && Date.now() < openBy) {
    const click = await command("Runtime.evaluate", {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find(item => item.title === 'Open your projects and conversations'); if (!button) return false; button.click(); return true; })()`,
      returnByValue: true,
    })
    assert.ok(!click.error, JSON.stringify(click.error))
    opened = click.value === true
    if (!opened) await delay(100)
  }
  assert.ok(opened, "Could not find the Agents button in the packaged Linux app")

  let state
  const readyBy = Date.now() + 15_000
  while (Date.now() < readyBy) {
    const result = await command("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        const workspace = document.querySelector('.agent-workspace');
        const canvas = document.querySelector('.agent-aurora canvas');
        const sidebar = document.querySelector('.agent-sidebar');
        if (canvas && !canvas.__stillGlassProbe) {
          canvas.__stillGlassProbe = true;
          window.__stillGlassCanvas = canvas;
          canvas.addEventListener('still:backdrop-frame', () => window.__stillGlassTextureProbe = true);
        }
        return {
          title: document.title,
          body: document.body.innerText,
          native: window.isTauri ? "true" : undefined,
          rendered: workspace?.dataset.frostRendered,
          managed: canvas?.dataset.frostManaged,
          hasTexture: !!window.__stillGlassTextureProbe,
          pixels: Number(canvas?.dataset.frostPixels || 0),
          frame: Number(canvas?.dataset.frostFrame || 0),
          background: sidebar ? getComputedStyle(sidebar).backgroundImage : ''
        };
      })())`,
      returnByValue: true,
      awaitPromise: true,
    })
    assert.ok(!result.error, JSON.stringify(result.error))
    try { state = JSON.parse(result.value) } catch {}
    if (state?.rendered === "true") break
    await delay(100)
  }
  await command("Runtime.evaluate", { expression: "window.__stillGlassCanvas?.dispatchEvent(new Event('still:backdrop-frame'))", returnByValue: true })
  const finalState = await command("Runtime.evaluate", {
    expression: `JSON.stringify((() => { const w=document.querySelector('.agent-workspace'),c=document.querySelector('.agent-aurora canvas'),s=document.querySelector('.agent-sidebar'); return {native:window.isTauri?'true':undefined,rendered:w?.dataset.frostRendered,managed:c?.dataset.frostManaged,hasTexture:!!window.__stillGlassTextureProbe,pixels:Number(c?.dataset.frostPixels||0),background:s?getComputedStyle(s).backgroundImage:''} })())`,
    returnByValue: true,
  })
  if (finalState.value) state = { ...state, ...JSON.parse(finalState.value) }
  assert.ok(state, "App page returned no inspectable state")
  assert.match(state.body, /Still workspace/, "Packaged Linux app rendered a blank page")
  assert.equal(state.native, "true", "Tauri runtime marker is missing")
  assert.equal(state.hasTexture, true, "Native glass refresh event was not handled")
  assert.equal(state.managed, "true", "Aurora canvas is not attached to the native glass renderer")
  assert.ok(state.pixels > 0 && state.pixels <= 48_000, `Blur texture exceeded the pixel budget: ${state.pixels}`)
  assert.match(state.background, /blob:/, "Sidebar is not using the native blur texture")
  console.log(JSON.stringify({ executable, smoke: "linux-webkitgtk-ui-and-native-glass", pixels: state.pixels, body: state.body.slice(0, 180) }, null, 2))
} finally {
  socket?.close()
  if (app.exitCode === null) app.kill("SIGTERM")
  await Promise.race([new Promise(resolve => app.once("exit", resolve)), delay(2_000)])
  if (app.exitCode === null) app.kill("SIGKILL")
}
