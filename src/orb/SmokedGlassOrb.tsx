import { useEffect, useRef } from "react"
import { GlassRenderer } from "./glassRenderer"
import type { OrbVisualState } from "./types"
import "./orb.css"

/**
 * THESIS: Still's chosen B study, a quiet smoked lens with light held inside.
 * OWN-WORLD: near-black shell, asymmetric silver rim, folded blue/pearl ribbon;
 * amber attention and red errors change the light, never the silhouette.
 * STORY: glance at a factual status; activate Still or drag the companion aside.
 * FIRST VIEWPORT: one 64px object, transparent surroundings, no panel or hero.
 * FORM: user-selected smoked-glass study; existing workspace stays unchanged.
 */
export default function SmokedGlassOrb({ state, size = 64, paused = false, force2D = false }: {
  state: OrbVisualState
  size?: number
  paused?: boolean
  /** Test fixture / constrained-client fallback; never drives session facts. */
  force2D?: boolean
}) {
  const host = useRef<HTMLSpanElement>(null)
  const renderer = useRef<GlassRenderer | null>(null)
  const current = useRef({ state, paused })
  current.current = { state, paused }
  useEffect(() => {
    if (!host.current) return
    const instance = new GlassRenderer(host.current, current.current.state, current.current.paused, force2D)
    renderer.current = instance
    return () => { instance.dispose(); renderer.current = null }
  }, [force2D])
  useEffect(() => { renderer.current?.update(state, paused) }, [state, paused])
  return <span className="smoked-glass" data-state={state} style={{ width: size, height: size }} aria-hidden="true">
    <span className="smoked-glass-host" ref={host} />
  </span>
}

export function OrbStateIcon({ state }: { state: OrbVisualState }) {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {state === "working" ? <path d="M4 6v4M8 3v10M12 5v6" /> : state === "needs-input" ? <><path d="m8 2 6 11H2Z" /><path d="M8 6v3M8 11h.01" /></> : state === "error" ? <><circle cx="8" cy="8" r="5.5" /><path d="m6 6 4 4m0-4-4 4" /></> : state === "done" ? <path d="m3 8 3.3 3.3L13 4.5" /> : state === "unknown" ? <><path d="M5.5 5.5a2.5 2.5 0 1 1 4 2C8 8.5 8 9 8 10" /><path d="M8 12h.01" /></> : <path d="M4 8h8" />}
  </svg>
}
