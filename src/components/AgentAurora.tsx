import { useEffect, useRef, useState } from "react"
import { createAuroraRenderer } from "../agents/auroraRenderer"
import { createGlassBackdrop } from "../agents/glassBackdrop"

/** One decorative particle horizon; never owns focus, input, or application state. */
export default function AgentAurora() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [paused, setPaused] = useState(true)
  const [rendered, setRendered] = useState<boolean | null>(null)

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const isNativeWindows = navigator.userAgent.includes("Windows") &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
    const renderer = createAuroraRenderer(element, isNativeWindows ? { maxParticles: 6000 } : undefined)
    if (!renderer) { setRendered(false); return }
    const glass = createGlassBackdrop(element)
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)")
    let width = 0, height = 0, frame = 0, lastFrame = 0, elapsed = 0, stopped = true

    const draw = () => {
      if (!width || !height) return
      renderer.draw(elapsed)
      // The shared native glass texture updates at its own lower cadence.
      glass?.draw()
    }

    // One visible canvas; the static SVG is only a fallback, not a second live layer.
    const tick = (now: number) => {
      if (stopped) return
      if (!lastFrame) lastFrame = now
      if (now - lastFrame >= 1000 / (isNativeWindows ? 20 : 30)) {
        elapsed += Math.min((now - lastFrame) / 1000, .1)
        lastFrame = now
        draw()
      }
      frame = requestAnimationFrame(tick)
    }

    const update = () => {
      stopped = document.hidden || reducedMotion.matches
      setPaused(stopped)
      cancelAnimationFrame(frame)
      lastFrame = 0
      if (!document.hidden) draw()
      if (!stopped) frame = requestAnimationFrame(tick)
    }
    const resize = () => {
      const rect = element.getBoundingClientRect()
      width = rect.width
      height = rect.height
      renderer.resize(width, height, devicePixelRatio || 1)
      if (!document.hidden) draw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    setRendered(true)
    update()
    document.addEventListener("visibilitychange", update)
    reducedMotion.addEventListener("change", update)
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      glass?.dispose()
      document.removeEventListener("visibilitychange", update)
      reducedMotion.removeEventListener("change", update)
    }
  }, [])

  return <div className="agent-aurora" data-paused={paused} data-rendered={rendered} aria-hidden="true"><canvas ref={canvas} /></div>
}
