import { useMemo, type PointerEvent as ReactPointerEvent } from "react"
import { type ConnState, type Session } from "../types"
import {
  frozenPreview,
  snapshotPreviewLines,
  snapshotPreviewScreen,
  useTranscriptVersion,
} from "../session/connections"

export type CardConn = ConnState | "never"

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
    dot: "bg-[#e8c4a0]",
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
 * with plain-text snapshots as a safe fallback after disconnect/reload.
 */
type PreviewState =
  | { kind: "screen"; lines: string[] }
  | { kind: "lines"; lines: string[] }
  | { kind: "none" }

function usePreviewLines(sessionId: string): PreviewState {
  // Hook order must stay stable: always subscribe, even when only the
  // persisted snapshot exists.
  const version = useTranscriptVersion(sessionId)
  return useMemo(() => {
    // Read the parsed xterm buffer first. This is the faithful path for both
    // ordinary shell output and fullscreen alternate-screen applications.
    const screen = snapshotPreviewScreen(sessionId)
    // A parsed but blank screen is still a valid terminal screen. Do not
    // fall back to stream fragments for a cleared/TUI screen.
    if (screen !== null) return { kind: "screen", lines: screen }

    // If xterm is unavailable, retain a safe plain-text fallback rather than
    // exposing raw escape sequences.
    const live = snapshotPreviewLines(sessionId)
    if (live.length > 0) return { kind: "lines", lines: live }
    const frozen = frozenPreview(sessionId)
    if (frozen && frozen.length > 0) return { kind: "lines", lines: frozen }
    return { kind: "none" }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, version])
}

function IdlePreview({ session }: { session: Session }) {
  const rows: string[] = []
  rows.push(`$ ${session.workingDirectory}`)
  if (session.host) rows.push(`${session.username}@${session.host}:${session.port}`)
  else rows.push("no host configured yet")
  rows.push(`tmux ${session.tmuxSession}`)
  rows.push("$ _")
  return (
    <div className="space-y-1">
      {rows.map((line, i) => (
        <div key={i} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
  )
}

export default function SessionCard({
  session,
  conn,
  index,
  dragging,
  dropHighlight,
  menuOpen,
  onOpen,
  onEdit,
  onRemove,
  onToggleMenu,
  onCardPointerDown,
}: {
  session: Session
  conn: CardConn
  index: number
  dragging: boolean
  dropHighlight: boolean
  menuOpen: boolean
  onOpen: (session: Session, el: HTMLElement) => void
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
          if (dragging) return
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
          if (e.key === "Enter" && e.target === e.currentTarget)
            onOpen(session, e.currentTarget)
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

        <CardPreview session={session} live={live} />

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

function CardPreview({ session, live }: { session: Session; live: boolean }) {
  const preview = usePreviewLines(session.id)
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
      <div className="px-3 py-2 text-[10px] leading-[1.65] text-[#b0aab8]">
        {preview.kind === "screen" || preview.kind === "lines" ? (
          <div className={`space-y-1 ${live ? "" : "opacity-70"}`} aria-hidden>
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 top-7 bg-gradient-to-t from-[#08080a] via-transparent to-transparent" />
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
