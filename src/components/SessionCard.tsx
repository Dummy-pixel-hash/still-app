import { useMemo } from "react"
import { type ConnState, type Session } from "../types"
import { transcriptSnapshot } from "../session/connections"

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

/** Last bytes of the live transcript rendered as plain text preview. */
function LivePreview({ sessionId }: { sessionId: string }) {
  const lines = useMemo(() => {
    const bytes = transcriptSnapshot(sessionId)
    if (bytes.length === 0) return null
    const text = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.slice(Math.max(0, bytes.length - 900)))
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    const out = text
      .split("\n")
      .map((l) => l.replace(/\s+$/g, ""))
      .filter((l) => l.length > 0)
      .slice(-4)
    return out.length > 0 ? out : null
  }, [sessionId])
  if (!lines) return null
  return (
    <div className="space-y-1">
      {lines.map((line, i) => (
        <div key={i} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
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
  menuOpen,
  onOpen,
  onEdit,
  onRemove,
  onToggleMenu,
  onDragStart,
  onDragEnd,
  onDropOn,
}: {
  session: Session
  conn: CardConn
  index: number
  dragging: boolean
  menuOpen: boolean
  onOpen: (session: Session, el: HTMLElement) => void
  onEdit: (session: Session) => void
  onRemove: (session: Session) => void
  onToggleMenu: (id: string | null) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDropOn: () => void
}) {
  const meta = statusMeta[conn]
  const live = conn === "connected"

  return (
    <div style={{ perspective: 900 }} className="rise">
      <div
        role="button"
        tabIndex={0}
        data-card={session.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move"
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onDropOn()
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
          if (e.key === "Enter" && e.target === e.currentTarget)
            onOpen(session, e.currentTarget)
        }}
        aria-label={`Open ${session.name} on ${session.host || "no host"}`}
        style={{
          animationDelay: `${index * 55}ms`,
          transform: "rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg))",
          transition: `transform 500ms ${EASE}, opacity 300ms, box-shadow 400ms`,
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.07) inset, 0 0 0 1px rgba(255,255,255,0.06), 0 24px 40px -18px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.5)",
        }}
        className={`group relative flex h-[286px] w-full cursor-pointer flex-col overflow-hidden rounded-[20px] bg-gradient-to-b from-[#141416] to-[#0b0b0c] p-4 text-left hover:shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_0_0_1px_rgba(255,90,90,0.18),0_30px_50px_-16px_rgba(0,0,0,1),0_0_60px_-20px_rgba(255,60,60,0.35)] ${
          dragging ? "opacity-30" : ""
        }`}
      >
        <span
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(260px circle at var(--mx,50%) var(--my,0%), rgba(255,255,255,0.07), transparent 60%)",
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-fg">
            {session.name}
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

        <div className="relative mt-4 flex-1 overflow-hidden rounded-[12px] bg-[#050505] px-3 py-2.5 font-mono text-[10px] leading-[1.65] text-[#b0aab8] shadow-[inset_0_1px_6px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.04)]">
          {live ? <LivePreview sessionId={session.id} /> : <IdlePreview session={session} />}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[#050505] to-transparent" />
        </div>

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
