import { glassFragment, glassVertex } from "./glassShader"
import type { OrbVisualState } from "./types"

type RGB = [number, number, number]
interface Palette { primary: RGB; secondary: RGB; pearl: RGB }
interface Material extends Palette { speed: number; activity: number }
const materials: Record<OrbVisualState, Material> = {
  idle: { speed: 0.13, activity: 0.2, primary: [0.45, 0.51, 0.64], secondary: [0.65, 0.66, 0.76], pearl: [0.84, 0.87, 0.93] },
  unknown: { speed: 0.1, activity: 0.16, primary: [0.38, 0.46, 0.61], secondary: [0.53, 0.57, 0.69], pearl: [0.76, 0.81, 0.89] },
  working: { speed: 1, activity: 1, primary: [0.29, 0.62, 1], secondary: [0.71, 0.48, 0.99], pearl: [0.94, 0.91, 0.83] },
  "needs-input": { speed: 0.35, activity: 0.65, primary: [1, 0.66, 0.24], secondary: [1, 0.39, 0.23], pearl: [1, 0.93, 0.77] },
  done: { speed: 0, activity: 0.28, primary: [0.34, 0.77, 0.59], secondary: [0.37, 0.75, 0.8], pearl: [0.85, 0.97, 0.89] },
  error: { speed: 0, activity: 0.35, primary: [0.97, 0.35, 0.4], secondary: [0.81, 0.34, 0.61], pearl: [1, 0.84, 0.83] },
}
const rgb = (color: RGB, alpha = 1) => `rgba(${color.map(v => Math.round(v * 255)).join(",")},${alpha})`

/** Owns its canvas and all GPU/observer resources; safe across React StrictMode. */
export class GlassRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private program: WebGLProgram | null = null
  private buffer: WebGLBuffer | null = null
  private shaders: WebGLShader[] = []
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private raf = 0
  private disposed = false
  private visible = true
  private dirty = true
  private state: OrbVisualState
  private paused: boolean
  private from: Palette
  private transitionAt = performance.now() - 1000
  private stateAt = performance.now()
  private lastTick = performance.now()
  private lastPaint = 0
  private time = 13.4
  private pulseTime = 0
  private media = matchMedia("(prefers-reduced-motion: reduce)")
  private resizeObserver: ResizeObserver
  private intersectionObserver: IntersectionObserver

  constructor(private host: HTMLElement, state: OrbVisualState, paused: boolean, force2D = false) {
    this.state = state
    this.paused = paused
    this.from = materials[state]
    this.canvas = this.makeCanvas()
    try {
      if (!force2D) this.setupGL()
      else this.fallback()
    } catch {
      this.fallback()
    }
    this.resizeObserver = new ResizeObserver(this.resize)
    this.resizeObserver.observe(host)
    this.intersectionObserver = new IntersectionObserver(entries => {
      this.visible = entries.some(entry => entry.isIntersecting)
      this.wake()
    })
    this.intersectionObserver.observe(host)
    document.addEventListener("visibilitychange", this.wake)
    window.addEventListener("resize", this.resize)
    this.media.addEventListener("change", this.wake)
    this.resize()
  }

  private makeCanvas() {
    const canvas = document.createElement("canvas")
    canvas.setAttribute("aria-hidden", "true")
    canvas.className = "smoked-glass-canvas"
    this.host.appendChild(canvas)
    return canvas
  }

  private setupGL() {
    const gl = this.canvas.getContext("webgl", {
      alpha: true, antialias: false, premultipliedAlpha: true, depth: false, stencil: false,
      // Static/paused frames must survive redraws. This is a tiny bounded canvas.
      preserveDrawingBuffer: true, powerPreference: "low-power",
    })
    if (!gl) throw new Error("WebGL unavailable")
    this.gl = gl
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error("Shader allocation failed")
      this.shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Shader unavailable")
      return shader
    }
    const vertex = compile(gl.VERTEX_SHADER, glassVertex)
    const fragment = compile(gl.FRAGMENT_SHADER, glassFragment)
    this.program = gl.createProgram()
    if (!this.program) throw new Error("Program allocation failed")
    gl.attachShader(this.program, vertex)
    gl.attachShader(this.program, fragment)
    gl.linkProgram(this.program)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error("Program unavailable")
    this.shaders.forEach(shader => gl.deleteShader(shader))
    this.shaders = []
    gl.useProgram(this.program)
    this.buffer = gl.createBuffer()
    if (!this.buffer) throw new Error("Buffer allocation failed")
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const location = gl.getAttribLocation(this.program, "aPosition")
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    for (const name of ["Resolution", "Time", "Activity", "Pulse", "Finish", "Primary", "Secondary", "Pearl"]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, `u${name}`)
    }
    this.canvas.addEventListener("webglcontextlost", this.contextLost)
    this.host.dataset.renderer = "webgl"
  }

  private releaseGL() {
    this.canvas.removeEventListener("webglcontextlost", this.contextLost)
    const gl = this.gl
    if (gl) {
      this.shaders.forEach(shader => gl.deleteShader(shader))
      if (this.buffer) gl.deleteBuffer(this.buffer)
      if (this.program) gl.deleteProgram(this.program)
      if (!gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext()
    }
    this.shaders = []
    this.program = null
    this.buffer = null
    this.gl = null
  }

  private contextLost = (event: Event) => {
    event.preventDefault()
    if (this.disposed) return
    this.fallback()
    this.resize()
  }

  private fallback() {
    this.releaseGL()
    this.canvas.remove()
    this.canvas = this.makeCanvas()
    this.ctx = this.canvas.getContext("2d")
    // The CSS material underneath remains if even Canvas2D is unavailable.
    this.host.dataset.renderer = this.ctx ? "2d" : "css"
  }

  private get frozen() { return this.paused || this.media.matches }

  private palette(now: number): Palette {
    const raw = this.frozen ? 1 : Math.min(1, Math.max(0, (now - this.transitionAt) / 650))
    const mix = raw * raw * (3 - 2 * raw)
    const target = materials[this.state]
    const blend = (a: RGB, b: RGB): RGB => a.map((from, i) => from + (b[i] - from) * mix) as RGB
    return { primary: blend(this.from.primary, target.primary), secondary: blend(this.from.secondary, target.secondary), pearl: blend(this.from.pearl, target.pearl) }
  }

  update(state: OrbVisualState, paused: boolean) {
    if (state !== this.state) {
      const now = performance.now()
      this.from = this.palette(now)
      this.transitionAt = now
      this.stateAt = now
      this.pulseTime = 0
      this.state = state
    }
    this.paused = paused
    this.wake()
  }

  private resize = () => {
    if (this.disposed) return
    const pixels = Math.max(32, Math.round(this.host.getBoundingClientRect().width * Math.min(window.devicePixelRatio || 1, 2)))
    if (this.canvas.width !== pixels || this.canvas.height !== pixels) {
      this.canvas.width = pixels
      this.canvas.height = pixels
    }
    this.wake()
  }

  private wake = () => {
    if (this.disposed) return
    this.dirty = true
    cancelAnimationFrame(this.raf)
    this.raf = 0
    if (document.hidden || !this.visible) return
    this.lastTick = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  private tick = (now: number) => {
    this.raf = 0
    if (this.disposed || document.hidden || !this.visible) return
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000))
    this.lastTick = now
    const material = materials[this.state]
    if (!this.frozen) { this.time += dt * material.speed; this.pulseTime += dt }
    if (this.dirty || now - this.lastPaint >= 1000 / (this.state === "idle" || this.state === "unknown" ? 15 : 30)) {
      const phase = this.pulseTime % 4.6
      const pulse = this.state === "needs-input" && !this.frozen
        ? Math.exp(-Math.pow((phase - 0.48) / 0.18, 2)) + Math.exp(-Math.pow((phase - 0.96) / 0.18, 2)) : 0
      const age = (now - this.stateAt) / 1000
      const finish = this.state === "done" && !this.frozen && age < 1.2 ? Math.sin(age / 1.2 * Math.PI) : 0
      const palette = this.palette(now)
      if (this.gl && this.program) {
        const gl = this.gl, u = this.uniforms
        gl.viewport(0, 0, this.canvas.width, this.canvas.height)
        gl.useProgram(this.program)
        gl.uniform2f(u.Resolution, this.canvas.width, this.canvas.height)
        gl.uniform1f(u.Time, this.time)
        gl.uniform1f(u.Activity, material.activity)
        gl.uniform1f(u.Pulse, pulse)
        gl.uniform1f(u.Finish, finish)
        gl.uniform3fv(u.Primary, palette.primary)
        gl.uniform3fv(u.Secondary, palette.secondary)
        gl.uniform3fv(u.Pearl, palette.pearl)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      } else this.draw2D(palette, pulse)
      this.dirty = false
      this.lastPaint = now
    }
    const transitioning = now - this.transitionAt < 700 || (this.state === "done" && now - this.stateAt < 1250)
    if (!this.frozen && (material.speed > 0 || transitioning)) this.raf = requestAnimationFrame(this.tick)
  }

  private draw2D({ primary, secondary, pearl }: Palette, pulse: number) {
    const ctx = this.ctx
    if (!ctx) return
    const width = this.canvas.width, radius = width * 0.356
    ctx.clearRect(0, 0, width, width)
    ctx.save()
    ctx.translate(width / 2, width / 2)
    ctx.globalAlpha = this.state === "needs-input" ? 0.86 + pulse * 0.14 : 1
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.clip()
    const body = ctx.createRadialGradient(-radius * 0.3, -radius * 0.45, 0, 0, 0, radius)
    body.addColorStop(0, "#141d2c"); body.addColorStop(0.55, "#03060d"); body.addColorStop(1, "#1c2430")
    ctx.fillStyle = body; ctx.fillRect(-radius, -radius, radius * 2, radius * 2)
    const ribbon = ctx.createLinearGradient(-radius, 0, radius, 0)
    ribbon.addColorStop(0, rgb(secondary)); ribbon.addColorStop(0.52, rgb(pearl)); ribbon.addColorStop(1, rgb(primary))
    const fold = Math.sin(this.time * 0.28) * 0.07
    const upper = () => {
      ctx.beginPath(); ctx.moveTo(-radius * 1.03, radius * 0.13)
      ctx.bezierCurveTo(-radius * 0.38, -radius * (0.43 + fold), radius * 0.2, -radius * 0.32, radius * 1.03, radius * 0.035)
    }
    const lower = () => {
      ctx.beginPath(); ctx.moveTo(-radius * 1.02, radius * 0.13)
      ctx.bezierCurveTo(-radius * 0.26, -radius * 0.1, radius * 0.23, radius * 0.33, radius * 1.03, radius * 0.035)
    }
    ctx.globalCompositeOperation = "screen"
    ctx.strokeStyle = ribbon
    ctx.filter = `blur(${radius * 0.12}px)`; ctx.lineWidth = radius * 0.24; upper(); ctx.stroke()
    ctx.filter = `blur(${radius * 0.025}px)`; ctx.lineWidth = radius * 0.075; upper(); ctx.stroke()
    const blue = ctx.createLinearGradient(-radius, 0, radius, 0)
    blue.addColorStop(0, rgb(secondary, 0.85)); blue.addColorStop(1, rgb(primary, 0.85))
    ctx.strokeStyle = blue
    ctx.filter = `blur(${radius * 0.085}px)`; ctx.lineWidth = radius * 0.16; lower(); ctx.stroke()
    ctx.filter = "none"; ctx.globalCompositeOperation = "source-over"
    const rim = ctx.createLinearGradient(-radius * 0.7, -radius, radius * 0.4, radius * 0.1)
    rim.addColorStop(0, "#eff5ff"); rim.addColorStop(0.7, "#576579"); rim.addColorStop(1, "#192131")
    ctx.beginPath(); ctx.arc(0, 0, radius * 0.985, Math.PI * 1.03, Math.PI * 1.66)
    ctx.lineWidth = radius * 0.018; ctx.strokeStyle = rim; ctx.stroke()
    ctx.beginPath(); ctx.arc(0, 0, radius * 0.985, Math.PI * 0.12, Math.PI * 0.73)
    ctx.lineWidth = radius * 0.012; ctx.strokeStyle = "#596478"; ctx.stroke()
    ctx.restore()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    this.intersectionObserver.disconnect()
    document.removeEventListener("visibilitychange", this.wake)
    window.removeEventListener("resize", this.resize)
    this.media.removeEventListener("change", this.wake)
    this.releaseGL()
    this.canvas.remove()
  }
}
