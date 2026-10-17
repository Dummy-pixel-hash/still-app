import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import SmokedGlassOrb from "../src/orb/SmokedGlassOrb"
import type { OrbVisualState } from "../src/orb/types"

const states: OrbVisualState[] = ["idle", "working", "needs-input", "done", "error", "unknown"]
function Fixture() {
  const [state, setState] = useState<OrbVisualState>("working")
  const [size, setSize] = useState(96)
  const [paused, setPaused] = useState(true)
  const [fallback, setFallback] = useState(false)
  return <main>
    <h1>Smoked glass · renderer fixture</h1>
    <p>Simulated visual states only. No sessions, network connections, or agent detection.</p>
    <section className="controls" aria-label="Fixture controls">
      <label>State <select aria-label="Visual state" value={state} onChange={e => setState(e.target.value as OrbVisualState)}>{states.map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Size <select aria-label="Visible size" value={size} onChange={e => setSize(Number(e.target.value))}>{[48, 64, 96, 176].map(s => <option key={s}>{s}</option>)}</select></label>
      <label><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} />Pause motion</label>
      <label><input type="checkbox" checked={fallback} onChange={e => setFallback(e.target.checked)} />Force Canvas2D</label>
    </section>
    <div className="samples"><section className="sample dark" data-testid="dark"><SmokedGlassOrb state={state} size={size} paused={paused} force2D={fallback} /><span>Dark backdrop</span></section><section className="sample light" data-testid="light"><SmokedGlassOrb state={state} size={size} paused={paused} force2D={fallback} /><span>Light backdrop</span></section></div>
    <div className="states">{states.map(s => <figure key={s}><SmokedGlassOrb state={s} size={64} paused /><figcaption>{s}</figcaption></figure>)}</div>
    <style>{`
      * { box-sizing: border-box; } :root { --font-sans: system-ui,sans-serif; }
      body { margin: 0; background:#111114; color:#e5e4eb; font:14px/1.5 system-ui,sans-serif; }
      main { max-width:1040px; margin:auto; padding:40px 24px; } h1 { font-size:26px; font-weight:500; margin:0 0 8px; } p { color:#b6b4c0; }
      .controls { display:flex; flex-wrap:wrap; gap:24px; padding:18px 0; border-top:1px solid #35343e; margin-top:24px; }
      label { display:flex; align-items:center; gap:8px; } select { background:#28282e; border:1px solid #51505c; border-radius:6px; padding:6px; color:inherit; }
      .samples { display:grid; grid-template-columns:1fr 1fr; } .sample { min-height:320px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:38px; }
      .dark { background:#08080b; } .light { background:#eae9e6; color:#46434d; } .sample>span:last-child { font-size:12px; }
      .states { display:flex; flex-wrap:wrap; justify-content:space-between; padding:32px 0; gap:16px; } figure { margin:0; display:grid; place-items:center; gap:20px; min-width:100px; } figcaption { color:#b6b4c0; font-size:12px; }
      @media(max-width:600px) { .samples { grid-template-columns:1fr; } .sample { min-height:270px; } .states { justify-content:center; gap:32px; } }
    `}</style>
  </main>
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>)
