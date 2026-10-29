const PANES = ".agent-sidebar,.agent-topbar,.agent-chat.is-launch.has-recents .agent-recents,.agent-review,.agent-picker-popup,.agent-model-menu,.agent-command-menu,.agent-context-choices,.agent-thread-menu,.agent-modal,.agent-toast"

/** Three separable box passes approximate a Gaussian. The input is already
 * composited onto opaque black, so there are no transparent-color fringes.
 * This CPU path deliberately does not depend on WebView2's CSS compositor. */
export function blurOpaquePixels(data: Uint8ClampedArray, width: number, height: number, radius: number, scratch: Uint8ClampedArray) {
  const span = radius * 2 + 1
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width
      let red = 0, green = 0, blue = 0
      for (let x = -radius; x <= radius; x++) {
        const offset = (row + Math.max(0, Math.min(width - 1, x))) * 4
        red += data[offset]; green += data[offset + 1]; blue += data[offset + 2]
      }
      for (let x = 0; x < width; x++) {
        const offset = (row + x) * 4
        scratch[offset] = red / span; scratch[offset + 1] = green / span; scratch[offset + 2] = blue / span; scratch[offset + 3] = 255
        const leaving = (row + Math.max(0, x - radius)) * 4
        const entering = (row + Math.min(width - 1, x + radius + 1)) * 4
        red += data[entering] - data[leaving]; green += data[entering + 1] - data[leaving + 1]; blue += data[entering + 2] - data[leaving + 2]
      }
    }
    for (let x = 0; x < width; x++) {
      let red = 0, green = 0, blue = 0
      for (let y = -radius; y <= radius; y++) {
        const offset = (Math.max(0, Math.min(height - 1, y)) * width + x) * 4
        red += scratch[offset]; green += scratch[offset + 1]; blue += scratch[offset + 2]
      }
      for (let y = 0; y < height; y++) {
        const offset = (y * width + x) * 4
        data[offset] = red / span; data[offset + 1] = green / span; data[offset + 2] = blue / span; data[offset + 3] = 255
        const leaving = (Math.max(0, y - radius) * width + x) * 4
        const entering = (Math.min(height - 1, y + radius + 1) * width + x) * 4
        red += scratch[entering] - scratch[leaving]; green += scratch[entering + 1] - scratch[leaving + 1]; blue += scratch[entering + 2] - scratch[leaving + 2]
      }
    }
  }
}

/** One small blurred scene texture shared by every native glass pane. It samples
 * the real particle canvas, not a decorative gradient or a second simulation. */
export function createGlassBackdrop(source: HTMLCanvasElement) {
  const root = source.closest<HTMLElement>('.agent-workspace[data-native-shell="true"]')
  if (!root) return null
  const buffer = document.createElement("canvas")
  const context = buffer.getContext("2d", { willReadFrequently: true })
  if (!context) return null
  source.dataset.frostManaged = "true"
  let scratch = new Uint8ClampedArray(0), disposed = false, busy = false, dirty = false
  let frame = 0, revision = 0, lastDraw = -Infinity, currentUrl = ""
  const urls = new Set<string>(), panes = new Set<HTMLElement>()

  const position = () => {
    const bounds = root.getBoundingClientRect()
    root.style.setProperty("--ag-frost-width", `${bounds.width}px`)
    root.style.setProperty("--ag-frost-height", `${bounds.height}px`)
    for (const pane of panes) {
      const rect = pane.getBoundingClientRect()
      pane.style.setProperty("--ag-frost-x", `${bounds.left - rect.left}px`)
      pane.style.setProperty("--ag-frost-y", `${bounds.top - rect.top}px`)
    }
  }

  const draw = (force = false) => {
    if (disposed || document.hidden) return
    if (busy) { dirty ||= force; return }
    const now = performance.now()
    if (!force && now - lastDraw < 1000 / 15) return
    const bounds = root.getBoundingClientRect(), scene = source.getBoundingClientRect()
    if (!bounds.width || !bounds.height || !source.width || !source.height) return
    lastDraw = now; busy = true
    const scale = Math.min(.25, Math.sqrt(120_000 / (bounds.width * bounds.height)))
    const width = Math.max(1, Math.ceil(bounds.width * scale)), height = Math.max(1, Math.ceil(bounds.height * scale))
    if (buffer.width !== width || buffer.height !== height || scratch.length !== width * height * 4) { buffer.width = width; buffer.height = height; scratch = new Uint8ClampedArray(width * height * 4) }
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = "#050505"; context.fillRect(0, 0, width, height)
    context.globalAlpha = Number(getComputedStyle(source.parentElement!).opacity)
    context.drawImage(source, (scene.left - bounds.left) * scale, (scene.top - bounds.top) * scale, scene.width * scale, scene.height * scale)
    context.globalAlpha = 1
    const image = context.getImageData(0, 0, width, height)
    blurOpaquePixels(image.data, width, height, Math.max(1, Math.round(26 * scale)), scratch)
    context.putImageData(image, 0, 0)
    position()
    buffer.toBlob(async blob => {
      if (!blob || disposed) { busy = false; return }
      const url = URL.createObjectURL(blob); urls.add(url)
      try {
        const decoded = new Image(); decoded.src = url
        await decoded.decode()
        if (disposed) return
        const previous = currentUrl; currentUrl = url
        root.style.setProperty("--ag-frost-image", `url("${url}")`)
        root.dataset.frostRendered = "true"
        source.dataset.frostFrame = String(++revision)
        if (previous) { URL.revokeObjectURL(previous); urls.delete(previous) }
      } catch {
        URL.revokeObjectURL(url); urls.delete(url)
      } finally {
        busy = false
        if (disposed) { URL.revokeObjectURL(url); urls.delete(url) }
        else if (dirty) { dirty = false; requestDraw() }
      }
    }, "image/png")
  }

  const requestDraw = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => draw(true))
  }
  const resize = new ResizeObserver(requestDraw)
  const discover = () => {
    const found = new Set(root.querySelectorAll<HTMLElement>(PANES))
    for (const pane of panes) if (!found.has(pane)) { resize.unobserve(pane); panes.delete(pane) }
    for (const pane of found) if (!panes.has(pane)) { panes.add(pane); pane.dataset.agentFrost = ""; resize.observe(pane) }
    position()
    if (!currentUrl) requestDraw()
  }
  const mutations = new MutationObserver(discover)
  mutations.observe(root, { childList: true, subtree: true })
  resize.observe(root)
  discover()
  root.addEventListener("scroll", position, true)
  source.addEventListener("still:backdrop-frame", requestDraw)

  return {
    draw,
    dispose() {
      disposed = true; cancelAnimationFrame(frame)
      mutations.disconnect(); resize.disconnect()
      root.removeEventListener("scroll", position, true)
      source.removeEventListener("still:backdrop-frame", requestDraw)
      delete root.dataset.frostRendered
      delete source.dataset.frostManaged
      delete source.dataset.frostFrame
      root.style.removeProperty("--ag-frost-image")
      root.style.removeProperty("--ag-frost-width"); root.style.removeProperty("--ag-frost-height")
      for (const pane of panes) {
        delete pane.dataset.agentFrost
        pane.style.removeProperty("--ag-frost-x"); pane.style.removeProperty("--ag-frost-y")
      }
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    },
  }
}
