import { useEffect, useRef, useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import { updateSettings } from "../session/store"
import SmokedGlassOrb from "./SmokedGlassOrb"
import type { OrbPreferences, OrbSize, OrbSpeed } from "./types"
import type { OrbPublisherState } from "./publisher"

export default function OrbSettings({ preferences, runtime }: {
  preferences: OrbPreferences
  runtime: OrbPublisherState & { retry(): void }
}) {
  const [message, setMessage] = useState("")
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const update = (patch: Partial<OrbPreferences>) => {
    setMessage("")
    updateSettings({ orb: { ...preferences, ...patch } })
  }
  return <section className="orb-settings" aria-labelledby="orb-settings-heading">
    <h3 id="orb-settings-heading" className="orb-settings-heading">Orb companion</h3>
    <div className="orb-settings-intro">
      <figure className="orb-settings-material" aria-label="Smoked glass appearance preview, not a session status">
        <SmokedGlassOrb state="working" size={56} paused={preferences.paused} speed={preferences.speed} />
        <figcaption>Material preview</figcaption>
      </figure>
      <div>
        <label className="orb-settings-toggle">
          <input type="checkbox" checked={preferences.enabled} onChange={event => update({ enabled: event.target.checked })} aria-label="Enable orb companion" />
          {nativeBridge.isDevelopmentAdapter ? "Show in-app preview" : "Float above other apps"}
        </label>
        <p className="orb-settings-copy">Smoked glass. Click to return to a session, drag to move, or right-click for controls.</p>
        {nativeBridge.isDevelopmentAdapter ? <p className="orb-settings-copy">Browser preview only; it stays inside this window.</p> : null}
      </div>
    </div>
    <div className="orb-settings-controls">
      <label>Size
        <select aria-label="Orb size" value={preferences.size} onChange={event => update({ size: Number(event.target.value) as OrbSize })}>
          <option value={48}>48 px</option><option value={64}>64 px</option><option value={96}>96 px</option>
        </select>
      </label>
      <label>Animation speed
        <select aria-label="Animation speed" value={preferences.speed} onChange={event => update({ speed: event.target.value as OrbSpeed })}>
          <option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option>
        </select>
      </label>
      <label className="orb-motion-label">
        <input type="checkbox" checked={!preferences.paused} onChange={event => update({ paused: !event.target.checked })} />
        Animate orb
      </label>
      <button type="button" className="orb-settings-button" disabled={!preferences.enabled || runtime.pending || !!runtime.error} onClick={() => {
        void nativeBridge.orbCommand({ type: "reset" }).then(() => {
          if (mounted.current) setMessage("Position reset.")
        }).catch(() => { if (mounted.current) setMessage("Could not reset position. Try again.") })
      }}>Reset position</button>
    </div>
    <p className="orb-settings-status">Animation speed applies to the companion and this preview. Motion respects your system’s reduced-motion preference.</p>
    <p className="orb-settings-status">Shows connection activity and sign-in or host-key prompts. Agent approval and completion signals aren’t connected yet.</p>
    <div role="status" aria-live="polite">
      {runtime.error ? <div className="orb-settings-status orb-settings-error"><p>{runtime.error}</p><button type="button" className="orb-settings-button mt-2" onClick={runtime.retry}>Retry companion</button></div>
        : runtime.pending ? <p className="orb-settings-status">Updating companion…</p>
        : message ? <p className="orb-settings-status">{message}</p> : null}
    </div>
  </section>
}
