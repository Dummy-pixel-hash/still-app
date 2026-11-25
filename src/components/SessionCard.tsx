import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import "@xterm/xterm/css/xterm.css"
import { type Project, type Session } from "../types"
import StatusBadge, { type CardConn } from "./StatusBadge"
import Menu, { useMenuButton, type MenuItemDef } from "../ui/Menu"
import type { ResolvedAppearance } from "../terminal/appearance"
import { terminalCssVars } from "../terminal/useTerminalAppearance"
import {
  frozenPreview,
  openPreview,
  snapshotPreviewLines,
  snapshotPreviewScreen,
  TERMINAL_LINE_HEIGHT,
  useTranscriptVersion,
  type FrozenScreen,
} from "../session/connections"

export type { CardConn }

/** Fit the rendered screen to this card, without changing its terminal grid. */
function fitPreview(host: HTMLElement) {
  const screen = host.querySelector<HTMLElement>(".xterm-screen, [data-frozen-screen]")
  if (!screen) return
  const sw = screen.offsetWidth
  const sh = screen.offsetHeight
  const width = host.clientWidth
  const height = host.clientHeight
  if (sw <= 0 || sh <= 0 || width <= 0 || height <= 0) return
  const scale = Math.min(1, width / sw, height / sh)
  screen.style.transform = `scale(${scale})`
  screen.style.left = `${(width - sw * scale) / 2}px`
  screen.style.top = `${(height - sh * scale) / 2}px`
}

/** Live and saved screens use the same fit, including after a DOM replacement. */
function usePreviewFit(prepare?: (host: HTMLElement) => void) {
  const hostRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const screenRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => fitPreview(host))
    observerRef.current = observer
    observer?.observe(host)
    let cancelled = false
    const fit = () => {
      if (!cancelled) fitPreview(host)
    }
    void document.fonts.ready.then(fit)
    document.fonts.addEventListener("loadingdone", fit)
    return () => {
      cancelled = true
      observer?.disconnect()
      observerRef.current = null
      screenRef.current = null
      document.fonts.removeEventListener("loadingdone", fit)
    }
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    prepare?.(host)
    const screen = host.querySelector<HTMLElement>(".xterm-screen, [data-frozen-screen]")
    if (screen !== screenRef.current) {
      if (screenRef.current) observerRef.current?.unobserve(screenRef.current)
      if (screen) observerRef.current?.observe(screen)
      screenRef.current = screen
    }
    fitPreview(host)
  })
  return hostRef
}

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
  appearance: ResolvedAppearance,
  live: boolean,
): PreviewState {
  const fontSize = appearance.fontSize
  const theme = appearance.xtermTheme
  // Hook order must stay stable: always subscribe, even when only the
  // persisted snapshot exists.
  const version = useTranscriptVersion(sessionId)
  return useMemo(() => {
    // Read the parsed xterm buffer first. This is the faithful path for both
    // ordinary shell output and fullscreen alternate-screen applications.
    const screen = snapshotPreviewScreen(sessionId, fontSize, theme)
    // A parsed but blank screen is still a valid terminal screen. Do not
    // fall back to stream fragments for a cleared/TUI screen.
    if (screen !== null) return { kind: "screen", lines: screen }

    // If xterm is unavailable, retain a safe plain-text fallback rather than
    // exposing raw escape sequences. Without a current screen, the frozen
    // copy could be the PREVIOUS connection's last screen — only
    // prefer it once the session is actually detached. While connected, the
    // live tail is the honest thing to show.
    const frozen = live ? null : frozenPreview(sessionId)
    if (frozen)
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
  }, [sessionId, fontSize, theme, live, version])
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
  appearance,
}: {
  sessionId: string
  appearance: ResolvedAppearance
}) {
  useTranscriptVersion(sessionId)
  const hostRef = usePreviewFit((host) => openPreview(sessionId, host, appearance.fontSize, appearance.xtermTheme))
  return (
    <div
      ref={hostRef}
      aria-hidden
      className="card-term pointer-events-none overflow-hidden select-none"
    />
  )
}

function SavedScreen({ screen, fontSize }: { screen: FrozenScreen; fontSize: number }) {
  const hostRef = usePreviewFit()
  return (
    <div ref={hostRef} className="card-term pointer-events-none overflow-hidden select-none" aria-hidden>
      <div
        data-frozen-screen
        data-cols={screen.cols}
        data-rows={screen.rows}
        className="card-mini card-frozen-screen text-[color:var(--term-preview-fg,#b0aab8)]"
        style={{
          width: `${screen.cols}ch`,
          height: `${screen.rows * TERMINAL_LINE_HEIGHT}em`,
          fontSize,
          lineHeight: TERMINAL_LINE_HEIGHT,
        }}
      >
        {screen.lines.map((line, i) => <div key={i}>{line || "\u00a0"}</div>)}
      </div>
    </div>
  )
}

function IdlePreview({ session }: { session: Session }) {
  const rows: string[] = []
  rows.push(`$ ${session.workingDirectory}`)
  if (session.host) rows.push(`${session.username}@${session.host}:${session.port}`)
  else rows.push("no host configured yet")
  rows.push("$ _")
  return (
    <div className="card-mini text-[color:var(--term-preview-fg,#b0aab8)]">
      {rows.map((line, i) => (
        <div key={i} className="truncate whitespace-pre">
          {line}
        </div>
      ))}
    </div>
  )
}

/**
 * One session card. Markup: an <article> (the [data-card] wrapper) holding
 * the visual shell, a full-card "Open" button, and — as SIBLINGS of that
 * button, never nested in it — the actions menu button and the (decorative)
 * drag grip. Keyboard users reorder through the menu instead of the grip.
 */
function SessionCard({
  session,
  conn,
  index,
  appearance,
  dragging,
  dropHighlight,
  menuOpen,
  tabStop = true,
  errorText,
  projects = [],
  canReorder = false,
  isFirst = true,
  isLast = true,
  onOpen,
  onOpenAgent,
  onEdit,
  onRemove,
  onToggleMenu,
  onCardPointerDown,
  onMove,
  onMoveToProject,
  onCardFocus,
}: {
  session: Session
  conn: CardConn
  index: number
  appearance: ResolvedAppearance
  dragging: boolean
  dropHighlight: boolean
  menuOpen: boolean
  /** Roving tabindex: only one card in the workspace is a Tab stop. */
  tabStop?: boolean
  /** Connection error text, exposed as the Open button's description. */
  errorText?: string
  projects?: Project[]
  canReorder?: boolean
  isFirst?: boolean
  isLast?: boolean
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
  onMove?: (session: Session, direction: -1 | 1) => void
  onMoveToProject?: (session: Session, projectId: string) => void
  onCardFocus?: (id: string) => void
}) {
  const live = conn === "connected"
  const shellRef = useRef<HTMLDivElement>(null)
  const [menuView, setMenuView] = useState<"main" | "move">("main")
  const menu = useMenuButton({
    open: menuOpen,
    onOpenChange: (next) => {
      setMenuView("main")
      onToggleMenu(next ? session.id : null)
    },
  })
  const errId = `${session.id}-err`
  const titleId = `${session.id}-title`

  const mainItems: MenuItemDef[] = [
    ...(onOpenAgent ? [{ id: "agent", label: "Start agent", onSelect: () => onOpenAgent(session) }] : []),
    { id: "open", label: "Open", onSelect: () => onOpen(session, shellRef.current ?? (document.querySelector(`[data-card="${session.id}"]`) as HTMLElement)) },
    { id: "edit", label: "Edit", onSelect: () => onEdit(session) },
    ...(onMove && canReorder
      ? [
          { id: "earlier", label: "Move earlier", disabled: isFirst, restoreFocus: true, onSelect: () => onMove(session, -1) },
          { id: "later", label: "Move later", disabled: isLast, restoreFocus: true, onSelect: () => onMove(session, 1) },
        ]
      : []),
    ...(onMoveToProject && projects.length > 1
      ? [{ id: "move-project", label: "Move to project…", keepOpen: true, onSelect: () => setMenuView("move") }]
      : []),
    { id: "remove", label: "Remove", danger: true, onSelect: () => onRemove(session) },
  ]
  const moveItems: MenuItemDef[] = [
    { id: "back", label: "‹ Back", keepOpen: true, onSelect: () => setMenuView("main") },
    ...projects
      .filter((p) => p.id !== session.projectId)
      .map((p) => ({ id: `to-${p.id}`, label: p.name, restoreFocus: true, onSelect: () => onMoveToProject?.(session, p.id) })),
  ]

  return (
    <article
      className="rise relative"
      data-card={session.id}
      aria-labelledby={titleId}
    >
      <div
        ref={shellRef}
        onPointerDown={(e) => {
          // The actions menu and form controls keep native behaviour (click,
          // scroll). The full-card Open button and the grip start a drag.
          const t = e.target as HTMLElement
          if (t.closest("[data-menu],[data-menu-button],a,input,select,textarea")) return
          onCardPointerDown(e, session, e.currentTarget)
        }}
        style={{
          animationDelay: `${index * 55}ms`,
          transition: `opacity 300ms, box-shadow 400ms`,
          // Drag source dims slightly while the floating ghost follows the
          // pointer; drop targets light up instead.
          cursor: dragging ? "grabbing" : undefined,
          opacity: dragging ? 0.35 : undefined,
          boxShadow: dropHighlight
            ? "0 1px 0 rgba(255,255,255,0.07) inset, 0 0 0 2px rgba(255,255,255,0.5), 0 18px 32px -18px rgba(0,0,0,0.8), 0 0 28px -8px rgba(255,255,255,0.15)"
            : "0 0 0 1px rgba(255,255,255,0.06), 0 14px 28px -18px rgba(0,0,0,0.75)",
        }}
        className="group relative flex h-[286px] w-full cursor-pointer flex-col overflow-hidden rounded-[20px] bg-gradient-to-b from-[#141416] to-[#0b0b0c] p-4 text-left hover:shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_20px_36px_-16px_rgba(0,0,0,0.9)] focus-within:shadow-[0_0_0_2px_rgba(255,255,255,0.4)] forced-colors:border forced-colors:border-[CanvasText]"
      >
        {/* Full-card Open button. Its accessible name is the contract
            tests-terminal/reopen.spec.ts relies on. */}
        <button
          type="button"
          data-card-open
          tabIndex={tabStop ? 0 : -1}
          aria-label={`Open ${session.name} on ${session.host || "no host"}`}
          aria-describedby={errorText ? errId : undefined}
          onFocus={() => onCardFocus?.(session.id)}
          onClick={(e) => onOpen(session, e.currentTarget.closest<HTMLElement>("[data-card]") ?? e.currentTarget)}
          className="absolute inset-0 z-10 cursor-pointer rounded-[20px]"
        />
        <div className="pointer-events-none flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* Decorative: pointer/touch drag only. Keyboard users reorder
                through the actions menu ("Move earlier/later", "Move to project…"). */}
            <span
              data-drag-handle
              aria-hidden
              title="Drag to move"
              className="pointer-events-auto relative z-20 shrink-0 cursor-grab touch-none select-none rounded px-1 font-mono text-[13px] leading-none text-faint opacity-0 transition hover:bg-white/[0.07] hover:text-fg active:cursor-grabbing group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            >
              ⠿
            </span>
            <h3 id={titleId} className="truncate text-[15px] font-medium tracking-[-0.01em] text-fg">
              {session.name}
            </h3>
          </span>
          <StatusBadge conn={conn} />
        </div>
        <div className="pointer-events-none mt-0.5 flex items-center justify-between gap-2 font-mono text-xs text-faint">
          <span className="truncate">{session.host || "—"}</span>
          <span className="sr-only">Theme {appearance.theme.name}</span>
        </div>
        {errorText ? <span id={errId} className="sr-only">Error: {errorText}</span> : null}

        <CardPreview session={session} live={live} appearance={appearance} />

        <div className="pointer-events-none mt-3 flex items-center justify-between text-xs text-faint">
          <span className="truncate font-mono">
            {session.username ? `${session.username}@` : ""}
            {session.workingDirectory}
          </span>
          {/* spacer: the real menu button sits above it, outside the Open button */}
          <span className="ml-2 h-6 w-9 shrink-0" aria-hidden />
        </div>
      </div>

      <div className="absolute bottom-3 right-3 z-20" data-menu-wrap>
        <button
          ref={menu.ref}
          type="button"
          data-menu-button
          tabIndex={tabStop ? 0 : -1}
          aria-label={`Actions for ${session.name}`}
          {...menu.props}
          className="rounded-md px-2 py-1 font-mono text-[13px] leading-none text-faint transition hover:bg-white/[0.07] hover:text-fg"
        >
          •••
        </button>
        {menuOpen ? (
          <Menu
            id={menu.menuId}
            label={`${session.name} actions`}
            anchorRef={menu.ref}
            items={menuView === "main" ? mainItems : moveItems}
            onClose={() => {
              setMenuView("main")
              onToggleMenu(null)
            }}
            className="bottom-8 right-0 w-44"
          />
        ) : null}
      </div>
    </article>
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
  appearance,
}: {
  session: Session
  live: boolean
  appearance: ResolvedAppearance
}) {
  const fontSize = appearance.fontSize
  // Live DOM screen: the real emulator DOM at the session's laid-out grid,
  // always mounted when bytes exist. Frozen/plain snapshots only when the
  // emulator is unavailable (never ran, cleared, dispose) and the idle
  // placeholder when nothing ever rendered.
  const preview = usePreview(session.id, appearance, live)
  return (
    <div style={terminalCssVars(appearance)} className="relative mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-[var(--term-bg,#08080a)] font-mono shadow-[inset_0_1px_6px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.04)]">
      {/* Miniature window chrome: traffic dots + session title. */}
      {/* a11y-exempt: decorative mini-chrome, hidden from assistive tech */}
      <div aria-hidden className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
        <span className="h-[7px] w-[7px] rounded-full bg-white/20" />
        <span className="h-[7px] w-[7px] rounded-full bg-white/20" />
        <span className="h-[7px] w-[7px] rounded-full bg-white/20" />
        <span className="ml-1.5 truncate text-[9px] tracking-wide text-faint">{session.tmuxSession}</span>
      </div>
      <div className="card-preview-body relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        {preview.kind === "screen" ? (
          <LiveScreen sessionId={session.id} appearance={appearance} />
        ) : preview.kind === "frozen" ? (
          <SavedScreen screen={preview} fontSize={fontSize} />
        ) : preview.kind === "lines" ? (
          <div className="card-mini text-[color:var(--term-preview-fg,#b0aab8)]" aria-hidden>
            {preview.lines.map((line, i) => (
              <div key={i} className="truncate whitespace-pre">
                {line}
                {live && i === preview.lines.length - 1 ? (
                  <span className="ml-1 inline-block h-[9px] w-[5px] translate-y-[1px] animate-[breathe_2.4s_ease-in-out_infinite] bg-[var(--term-cursor,#ff5a5a)]" />
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-[var(--term-bg,#08080a)] to-transparent" />
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
