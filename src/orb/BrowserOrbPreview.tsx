import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { nativeBridge } from "../bridge/nativeBridge"
import OrbButton from "./OrbButton"
import { OrbStateIcon } from "./SmokedGlassOrb"
import { clampOrbPosition, describeOrbRow } from "./state"
import { useOrbView } from "./useOrbView"
import type { OrbCommand } from "./types"

/** Explicit browser simulation. It never claims to float above other applications. */
export default function BrowserOrbPreview() {
  const { snapshot, summary, now, error } = useOrbView()
  const size = snapshot.preferences.size
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const positionRef = useRef(position)
  positionRef.current = position
  const origin = useRef(position)
  const placed = useRef(false)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const reset = useRef(() => {})
  reset.current = () => {
    setPosition(clampOrbPosition(innerWidth - size - 36, innerHeight - size - 76, innerWidth, innerHeight, size))
    setMenu(false)
  }
  useEffect(() => {
    let live = true
    let stop: (() => void) | undefined
    void nativeBridge.subscribeOrbActions(action => {
      if (live && action.type === "reset") reset.current()
    }).then(off => { if (live) stop = off; else off() }).catch(() => {})
    return () => { live = false; stop?.() }
  }, [])
  useLayoutEffect(() => {
    if (!snapshot.preferences.enabled) { placed.current = false; setMenu(false); return }
    if (!placed.current) { placed.current = true; reset.current() }
    else setPosition(p => clampOrbPosition(p.x, p.y, innerWidth, innerHeight, size))
    const resize = () => setPosition(p => clampOrbPosition(p.x, p.y, innerWidth, innerHeight, size))
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [snapshot.preferences.enabled, size])

  const closeMenu = (focus = true) => { setMenu(false); if (focus) button.current?.focus() }
  const send = (command: OrbCommand) => {
    closeMenu(false)
    setActionError(null)
    void nativeBridge.orbCommand(command).catch(() => setActionError("That action could not finish. Try again in Still."))
  }
  useLayoutEffect(() => {
    if (!menu || !menuRef.current || !button.current) return
    const node = menuRef.current, anchor = button.current.getBoundingClientRect()
    const width = node.offsetWidth, height = node.offsetHeight
    node.style.left = `${Math.max(12, Math.min(innerWidth - width - 12, anchor.right - width))}px`
    node.style.top = `${Math.max(12, Math.min(innerHeight - height - 12, anchor.top - height - 12))}px`
    node.querySelector<HTMLButtonElement>("button")?.focus()
  }, [menu, position, size, summary.rows.length])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) closeMenu(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu() }
      if (event.key === "Tab") closeMenu()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", key, true)
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true) }
  }, [menu])

  if (!snapshot.preferences.enabled) return null
  const label = error ?? actionError ?? summary.label
  return createPortal(<>
    <aside className="orb-preview" style={{ left: position.x, top: position.y }} aria-label="Browser-only orb preview">
      <OrbButton
        buttonRef={button} size={size} state={error ? "unknown" : summary.visual} paused={snapshot.preferences.paused}
        label={`Still orb preview — ${label}${summary.row ? ` · ${summary.row.name}` : ""}. Open session.`}
        title={`${label}\n${summary.detail}\nBrowser-only preview · drag to move · right-click for controls`}
        menuOpen={menu}
        activate={() => send({ type: "open" })}
        menu={() => setMenu(value => !value)}
        drag={(dx, dy, first) => {
          if (first) { origin.current = positionRef.current; setMenu(false) }
          setPosition(clampOrbPosition(origin.current.x + dx, origin.current.y + dy, innerWidth, innerHeight, size))
        }}
        nudge={(dx, dy) => { setMenu(false); setPosition(p => clampOrbPosition(p.x + dx, p.y + dy, innerWidth, innerHeight, size)) }}
      />
      <span className="orb-preview-label" style={{ left: Math.max(60, Math.min(innerWidth - 60, position.x + size / 2)) - position.x, top: position.y + size + 34 > innerHeight ? -30 : undefined }}>Browser preview</span>
      <span className="orb-sr-only" role="status">{label}</span>
    </aside>
    {menu ? <div
      ref={menuRef} role="menu" aria-label="Orb controls" className="orb-preview-menu"
      onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }}
    >
      <p className="orb-menu-note">Browser-only preview · no desktop overlay</p>
      <button role="menuitem" onClick={() => send({ type: "workspace" })}>Open Still</button>
      <div role="separator" className="orb-menu-separator" />
      {summary.rows.length ? summary.rows.slice(0, 12).map(row => {
        const status = describeOrbRow(row, now)
        return <button role="menuitem" key={row.sessionId} data-state={status.visual} onClick={() => send({ type: "open", sessionId: row.sessionId })}>
          <OrbStateIcon state={status.visual} />
          <span className="orb-menu-session"><strong>{row.name}</strong><span>{status.label}</span></span>
        </button>
      }) : <p className="orb-menu-note">{summary.label}</p>}
      {summary.rows.length > 12 ? <button role="menuitem" onClick={() => send({ type: "workspace" })}>More sessions in Still…</button> : null}
      <div role="separator" className="orb-menu-separator" />
      <button role="menuitem" onClick={() => send({ type: "pause", paused: !snapshot.preferences.paused })}>{snapshot.preferences.paused ? "Resume motion" : "Pause motion"}</button>
      <button role="menuitem" onClick={() => send({ type: "reset" })}>Reset position</button>
      <button role="menuitem" onClick={() => send({ type: "hide" })}>Hide orb</button>
    </div> : null}
  </>, document.body)
}
