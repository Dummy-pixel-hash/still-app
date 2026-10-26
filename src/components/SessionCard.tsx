import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { type ConnState, type Session } from "../types"
import {
  frozenPreview,
  openPreview,
  snapshotPreviewLines,
  snapshotPreviewScreen,
  useTranscriptVersion,
} from "../session/connections"

export type CardConn = ConnState | "never"

/** Height of the miniature screen viewport; the terminal grid is scaled
 *  to fit inside this box (width comes from the card layout). */
const PREVIEW_VIEWPORT_HEIGHT = 104
// The fit is measured for a card at its max grid width; a slightly smaller
// scale keeps the clamped geometry (e.g. 120 cols) inside the viewport.
const PREVIEW_FIT_MARGIN = 0.98

/** Scale the emulator's screen DOM to fit the card viewport. Reads layout
 *  (offsetWidth/Height), so callers batch it into a frame, not a render. */
function fitPreview(host: HTMLElement) {
  const screen = host.querySelector<HTMLElement>(".xterm-screen")
  if (!screen) return
  const sw = screen.offsetWidth
  const sh = screen.offsetHeight
  if (sw <= 0 || sh <= 0) return
  // The card grid clips overflow, so fit against the widest column the
  // layout allows (previews never exceed the real cols, so the clamp and
  // the fit stay consistent).
  const grid = host.closest("[data-card-grid]") as HTMLElement | null
  const fitW = grid?.clientWidth ?? host.clientWidth
  screen.style.transform = `scale(${Math.max(
    0.05,
    Math.min(PREVIEW_VIEWPORT_HEIGHT / sh, fitW / sw) * PREVIEW_FIT_MARGIN,
  )})`
}
const statusMeta: Record<CardConn,
  { label: string; dot: string; pulse: boolean }
> = {
  connected: {
    label: "Running",
    dot: "bg-[#ff4a4a] shadow-[0_0_8px_1px_rgba(255,74,74,0.7)]",
    pulse: true,
  },
  connecting: {
    label: "Connecting",
    dot: "bg-[#c9c4c0]",
    pulse: true,
  },
  error: {
    label: "Error",
    dot: "bg-[#ff4a4a]",
    pulse: false,
  },
  disconnected: {
    label: "Detached",
    dot: "border border-[#6b6764] bg-transparent",
    pulse: false,
  },
  never: {
    label: "Idle",
    dot: "bg-[#a9a4a0]",
    pulse: false,
  },
}

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"

/**
 * Card preview state: rows from a headless xterm screen emulator while live,
 * with plain-text snapshots as a safe fallback after disconnect/reload. The
 * screen rows carry the (capped) grid they were laid out in so the card can
 * reproduce the real terminal's line wrapping instead of reflowing.
 */
type PreviewState =
  | { kind: "screen"; lines: string[] }
  | { kind: "frozen"; lines: string[]; cols: number; rows: number }
  | { kind: "lines"; lines: string[] }
  | { kind: "none" }

function usePreview(
  sessionId: string,
  fontSize: number,
  live: boolean,
): PreviewState {
  // Hook order must stay stable: always subscribe, even when only the
  // persisted snapshot exists.
  const version = useTranscriptVersion(sessionId)
  return useMemo(() => {
    // Read the parsed xterm buffer first. This is the faithful path for both
    // ordinary shell output and fullscreen alternate-screen applications.
    const screen = snapshotPreviewScreen(sessionId, fontSize)
    // A parsed but blank screen is still a valid terminal screen. Do not
    // fall back to stream fragments for a cleared/TUI screen.
    if (screen !== null) return { kind: "screen", lines: screen }

    // If xterm is unavailable, retain a safe plain-text fallback rather than
    // exposing raw escape sequences. Snapshot() returns null mid-rebuild, so
    // the frozen copy would be the PREVIOUS session's last screen — only
    // prefer it once the session is actually detached. While connected, the
    // live tail is the honest thing to show.
    const frozen = frozenPreview(sessionId)
    if (frozen && frozen.lines.length > 0)
      return {
        kind: "frozen",
        lines: frozen.lines,
        cols: frozen.cols,
        rows: frozen.rows,
      }
    const tail = snapshotPreviewLines(sessionId)
    if (tail.length > 0) return { kind: "lines", lines: tail }
    return { kind: "none" }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, fontSize, live, version])
}

/**
 * Live miniature screen: the real headless xterm DOM, laid out at the
 * session's (capped) live grid and shrunk with a CSS transform to fit the
 * viewport, so wraps, TUIs and cursor addressing match the full overlay.
 * Falls back to null when no screen exists yet (caller shows the frozen
 * snapshot or IdlePreview) — never unmounts the terminal, just detaches
 * the host (openPreview re-homes the element on remount).
 */
function LiveScreen({
  sessionId,
  fontSize,
}: {
  sessionId: string
  fontSize: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  // Re-run when parsed frames land: terminal rebuilds (geometry change, ring
  // wrap) create a NEW instance, and xterm open() is a no-op on an
  // already-opened instance — so a stale host keeps the dead DOM without this.
  const version = useTranscriptVersion(sessionId)

  // Mount-level: open/re-home the emulator DOM and observe the hosts that
  // decide the fit. Rebuilding this per output frame would disconnect and
  // re-observe three elements, then force a layout read, on every parsed
  // burst — once per card.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const grid = host.closest("[data-card-grid]") as HTMLElement | null
    openPreview(sessionId, host, fontSize)
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => fitPreview(host))
    if (ro) {
      ro.observe(host)
      if (grid) ro.observe(grid)
      // Re-fit when the grid itself relayouts (webfont metrics landing, a
      // replayed frame changing the row set). scale() changes no layout
      // box, so this cannot feed back into itself.
      const screen = host.querySelector<HTMLElement>(".xterm-screen")
      if (screen) ro.observe(screen)
    }
    fitPreview(host)
    return () => ro?.disconnect()
  }, [sessionId, fontSize])

  // Per-frame: a rebuild (geometry change, ring wrap) creates a NEW terminal
  // instance, and xterm open() is a no-op on an already-opened one — so the
  // host must be re-homed and the fit recomputed. The observer is NOT rebuilt
  // here: it already watches the host and grid, so this is one layout read
  // per parsed frame instead of tearing down and re-observing three elements.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    openPreview(sessionId, host, fontSize)
    fitPreview(host)
  }, [sessionId, fontSize, version])
  return (
    <div
      ref={hostRef}
      aria-hidden
      className="card-term pointer-events-none overflow-hidden select-none"
    />
  )
}

function IdlePreview({ session }: { session: Session }) {
  const rows: string[] = []
  rows.push(`$ ${session.workingDirectory}`)
  if (session.host) rows.push(`${session.username}@${session.host}:${session.port}`)
  else rows.push("no host configured yet")
  rows.push(`tmux ${session.tmuxSession}`)
  rows.push("$ _")
  return (
    <div className="card-mini text-[#b0aab8]">
      {rows.map((line, i) => (
        <div key={i} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
  )
}

function SessionCard({
  session,
  conn,
  index,
  fontSize,
  dragging,
  dropHighlight,
  menuOpen,
  onOpen,
  onOpenAgent,

  onEdit,
  onRemove,
  onToggleMenu,
  onCardPointerDown,
}: {
  session: Session
  conn: CardConn
  index: number
  fontSize: number
  dragging: boolean
  dropHighlight: boolean
  menuOpen: boolean
  onOpen: (session: Session, el: HTMLElement) => void
  onOpenAgent?: (session: Session) => void

  onEdit: (session: Session) => void
  onRemove: (session: Session) => void
  onToggleMenu: (id: string | null) => void
  onCardPointerDown: (
    e: ReactPointerEvent,
    session: Session,
    el: HTMLElement,
  ) => void
}) {
  const meta = statusMeta[conn]
  const live = conn === "connected"

  return (
    <div
      style={{ perspective: 900 }}
      className="rise"
      data-card={session.id}
    >
      <div
        role="button"
        tabIndex={0}
        onPointerDown={(e) => {
          // Menu / form controls keep native behaviour (click, scroll).
          const t = e.target as HTMLElement
          if (t.closest("[data-menu],button,a,input,select,textarea")) {
            // The grip itself is a span (not a button) so it falls
            // through to drag even though it lives in the header.
            if (!t.closest("[data-drag-handle]")) return
          }
          onCardPointerDown(e, session, e.currentTarget)
        }}
        onMouseMove={(e) => {
          const el = e.currentTarget
          const r = el.getBoundingClientRect()
          const x = (e.clientX - r.left) / r.width
          const y = (e.clientY - r.top) / r.height
          el.style.setProperty("--ry", `${(x - 0.5) * 7}deg`)
          el.style.setProperty("--rx", `${(0.5 - y) * 7}deg`)
          el.style.setProperty("--mx", `${x * 100}%`)
          el.style.setProperty("--my", `${y * 100}%`)
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget
          el.style.setProperty("--ry", "0deg")
          el.style.setProperty("--rx", "0deg")
        }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-menu]")) return
          onOpen(session, e.currentTarget)
        }}
        onKeyDown={(e) => {
          // This div advertises role="button": honour both keys a button
          // responds to. (Space used to scroll the grid instead of opening.)
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault()
            onOpen(session, e.currentTarget)
          }
        }}
        aria-label={`Open ${session.name} on ${session.host || "no host"}`}
        style={{
          animationDelay: `${index * 55}ms`,
          transform: "rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg))",
          transition: `transform 500ms ${EASE}, opacity 300ms, box-shadow 400ms`,
          // Drag source dims slightly while the floating ghost follows the
          // pointer; drop targets light up instead.
          cursor: dragging ? "grabbing" : undefined,
          opacity: dragging ? 0.35 : undefined,
          boxShadow: dropHighlight
            ? "0 1px 0 rgba(255,255,255,0.07) inset, 0 0 0 2px rgba(255,74,74,0.65), 0 24px 40px -18px rgba(0,0,0,0.9), 0 0 32px -8px rgba(255,74,74,0.45)"
            : "0 1px 0 rgba(255,255,255,0.07) inset, 0 0 0 1px rgba(255,255,255,0.06), 0 24px 40px -18px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.5)",
        }}
        className="group relative flex h-[286px] w-full cursor-pointer flex-col overflow-hidden rounded-[20px] bg-gradient-to-b from-[#141416] to-[#0b0b0c] p-4 text-left hover:shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_0_0_1px_rgba(255,90,90,0.18),0_30px_50px_-16px_rgba(0,0,0,1),0_0_60px_-20px_rgba(255,60,60,0.35)]"
      >
        <span
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(260px circle at var(--mx,50%) var(--my,0%), rgba(255,255,255,0.07), transparent 60%)",
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              data-drag-handle
              role="separator"
              aria-label={`Drag ${session.name}`}
              title="Drag to move"
              className="shrink-0 cursor-grab touch-none select-none rounded px-1 font-mono text-[13px] leading-none text-faint transition hover:bg-white/[0.07] hover:text-fg active:cursor-grabbing"
            >
              ⠿
            </span>
            <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-fg">
              {session.name}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-[11px] text-dim">
            {meta.label}
            <span
              className={`h-[7px] w-[7px] rounded-full ${meta.dot} ${
                meta.pulse ? "animate-[breathe_2.4s_ease-in-out_infinite]" : ""
              }`}
            />
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between font-mono text-[11px] text-faint">
          <span className="truncate">{session.host || "—"}</span>
        </div>

        <CardPreview session={session} live={live} fontSize={fontSize} />

        <div className="mt-3 flex items-center justify-between text-[11px] text-faint">
          <span className="truncate font-mono text-[10px]">
            {session.username ? `${session.username}@` : ""}
            {session.workingDirectory} · {session.tmuxSession}
          </span>
          <span className="relative ml-2 shrink-0" data-menu>
            <button
              type="button"
              aria-label={`Actions for ${session.name}`}
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation()
                onToggleMenu(menuOpen ? null : session.id)
              }}
              className="rounded-md px-2 py-1 font-mono text-[13px] leading-none text-faint transition hover:bg-white/[0.07] hover:text-fg"
            >
              •••
            </button>
            {menuOpen ? (
              <span className="absolute bottom-7 right-0 z-20 flex w-36 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#121214]/95 py-1 text-[12px] shadow-[0_16px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl">
                {(
                  [
                    ...(onOpenAgent ? [["Start agent", () => onOpenAgent(session)] as const] : []),

                    ["Open", () => onOpen(session, document.querySelector(`[data-card="${session.id}"]`) as HTMLElement)],
                    ["Edit", () => onEdit(session)],
                    ["Remove", () => onRemove(session)],
                  ] as const
                ).map(([label, fn]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleMenu(null)
                      fn()
                    }}
                    className={`px-3 py-1.5 text-left transition hover:bg-white/[0.07] hover:text-fg ${
                      label === "Remove" ? "text-[#ff8080]" : "text-dim"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Card screen: a miniature terminal window. Live output while connected;
 * the frozen last-output snapshot after disconnect (kept in-memory and
 * restored from localStorage across reloads); the idle placeholder only
 * when the session never produced output.
 */

function CardPreview({
  session,
  live,
  fontSize,
}: {
  session: Session
  live: boolean
  fontSize: number
}) {
  // Live DOM screen: the real emulator DOM at the session's laid-out grid,
  // always mounted when bytes exist. Frozen/plain snapshots only when the
  // emulator is unavailable (never ran, cleared, dispose) and the idle
  // placeholder when nothing ever rendered.
  const preview = usePreview(session.id, fontSize, live)
  return (
    <div className="relative mt-4 flex-1 overflow-hidden rounded-[12px] bg-[#08080a] font-mono shadow-[inset_0_1px_6px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.04)]">
      {/* Miniature window chrome: traffic dots + session title. */}
      <div className="flex items-center gap-1.5 border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
        <span className="h-[7px] w-[7px] rounded-full bg-[#ff5f57]/80" />
        <span className="h-[7px] w-[7px] rounded-full bg-[#febc2e]/70" />
        <span className="h-[7px] w-[7px] rounded-full bg-[#28c840]/70" />
        <span className="ml-1.5 truncate text-[9px] tracking-wide text-faint">
          {session.tmuxSession}
          {!live ? " — snapshot" : ""}
        </span>
        {!live ? (
          <span className="ml-auto shrink-0 rounded border border-white/10 px-1 py-px text-[8px] uppercase tracking-[0.08em] text-faint">
            frozen
          </span>
        ) : null}
      </div>
      <div
        className="card-preview-body relative flex items-center justify-center overflow-hidden px-2"
        style={{ height: PREVIEW_VIEWPORT_HEIGHT }}
      >
        {preview.kind === "screen" ? (
          <LiveScreen sessionId={session.id} fontSize={fontSize} />
        ) : preview.kind === "frozen" ? (
          <div
            className="card-mini text-[#b0aab8]"
            data-cols={preview.cols}
            data-rows={preview.rows}
            aria-hidden
          >
            {preview.lines.map((line, i) => (
              <div key={i} className="truncate whitespace-pre">
                {line}
              </div>
            ))}
          </div>
        ) : preview.kind === "lines" ? (
          <div className="card-mini text-[#b0aab8]" aria-hidden>
            {preview.lines.map((line, i) => (
              <div key={i} className="truncate whitespace-pre">
                {line}
                {live && i === preview.lines.length - 1 ? (
                  <span className="ml-1 inline-block h-[9px] w-[5px] translate-y-[1px] animate-[breathe_2.4s_ease-in-out_infinite] bg-[#ff5a5a]" />
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <IdlePreview session={session} />
        )}
      </div>
      {/* Fade only the last few pixels: the newest lines are the reason to
          read the card, and the old top-7 gradient washed them out. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-[#08080a] to-transparent" />
      {/* Scanline sheen so the miniature reads as a screen, not text. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.022) 0 1px, transparent 1px 3px)",
        }}
      />
    </div>
  )
}

// The grid re-renders on every store bump; without this, one keystroke in a
// form field reconciles every card and every mounted preview. Props are
// primitives plus stable callbacks, so a shallow compare is enough.
export default memo(SessionCard)
