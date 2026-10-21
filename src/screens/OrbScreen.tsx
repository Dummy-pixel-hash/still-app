import { useEffect, useRef, useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import OrbButton from "../orb/OrbButton"
import { useOrbView } from "../orb/useOrbView"
import type { OrbCommand } from "../orb/types"

/** Isolated companion entry: no Workspace, store, xterm, or SSH subscriptions. */
export default function OrbScreen() {
  const { snapshot, summary, error } = useOrbView()
  const [actionError, setActionError] = useState<string | null>(null)
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const focus = () => setFocused(true)
    const blur = () => setFocused(false)
    window.addEventListener("focus", focus)
    window.addEventListener("blur", blur)
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("blur", blur) }
  }, [])
  const button = useRef<HTMLButtonElement>(null)
  const send = (command: OrbCommand) => {
    setActionError(null)
    void nativeBridge.orbCommand(command).catch(() => setActionError("That action could not finish. Try again, or open Still from the taskbar."))
  }
  const status = error ?? actionError ?? summary.label
  const name = summary.row ? ` · ${summary.row.name}` : ""
  // A native companion only exists while enabled; the browser route is a visible
  // preview, so it keeps its ambient drift even before a publisher arrives.
  const paused = snapshot.preferences.paused || (!snapshot.preferences.enabled && !nativeBridge.isDevelopmentAdapter)
  return <main className="orb-window-surface" data-window-focused={focused} aria-label="Still companion">
    <OrbButton
      buttonRef={button}
      nativeDrag
      interact={() => { if (!nativeBridge.isDevelopmentAdapter) send({ type: "focus" }) }}
      size={snapshot.preferences.size}
      state={error ? "unknown" : summary.visual}
      paused={paused}
      speed={snapshot.preferences.speed}
      label={`Still orb — ${status}${name}. Open Still. Right-click for sessions and controls.`}
      title={`${status}${name}\n${summary.detail}\nDrag to move · arrow keys to nudge · right-click for controls`}
      activate={() => send({ type: "open" })}
      menu={() => send({ type: "menu" })}
      drag={(_dx, _dy, first) => { if (first) send({ type: "drag" }) }}
      nudge={(dx, dy) => send({ type: "nudge", dx, dy })}
    />
    <span className="orb-sr-only" role="status" aria-live="polite">{status}{name}</span>
  </main>
}
