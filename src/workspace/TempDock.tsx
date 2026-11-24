import { connectionState } from "../session/connections"
import TerminalOverlay, { MORPH_MS, type OpenState } from "../components/TerminalOverlay"
import type { Session, ImageInsertStyle } from "../types"
import { EASE, type useTempDock } from "./useTempDock"

  // Temp dock helpers: aggregate status dot and per-temp label/state.
const tempAggregateDot = (list: Session[]) => {
    if (!list.length) return "bg-white/30"
    const states = list.map((t) => connectionState(t.id))
    if (states.includes("error")) return "bg-red-400"
    // Neutral while connecting: amber is "needs you" in the orb's own
    // vocabulary, and a starting session is not an alarm.
    if (states.some((s) => s === "connecting")) return "bg-white/40"
    if (states.every((s) => s === "connected")) return "bg-emerald-400"
    return "bg-white/30"
  }

const tempDotClass = (id: string) =>
    connectionState(id) === "connected"
      ? "bg-emerald-400"
      : connectionState(id) === "connecting"
        ? "bg-white/40"
        : connectionState(id) === "error"
          ? "bg-red-400"
          : "bg-white/30"


/** Docked temp terminals: tile overlays, resize handles and the dock pill. */
export default function TempDock({
  dock,
  imageInsertStyle,
  keyTextFor,
  onNeedAuth,
  onOpenPalette,
}: {
  dock: ReturnType<typeof useTempDock>
  imageInsertStyle: ImageInsertStyle
  keyTextFor: (keyId: string) => string | null
  onNeedAuth: (s: Session) => Promise<{ secret?: string; remember: boolean } | null>
  onOpenPalette?: (sessionId: string) => void
}) {
  // Plain render helpers (not components): rows keep their React identity
  // across parent re-renders instead of remounting on every keystroke.
  const tempRow = (temp: Session) => {
    const isOpen = Boolean(dock.openTemps[temp.id])
    return (
      <li
        key={temp.id}
        className={`temp-row-in flex items-center gap-2 rounded-md border px-2 py-1 font-mono text-xs uppercase tracking-[0.15em] ${isOpen ? "border-amber-300/70 text-still-fg" : "border-white/10 text-still-dim"}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tempDotClass(temp.id)}`} aria-hidden />
        <span className="truncate">{temp.name} · {connectionState(temp.id)}</span>
        <button
          type="button"
          disabled={isOpen}
          onClick={() => dock.morphTemp(temp, document.getElementById("temp-pill"))}
          className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-xs uppercase tracking-wide hover:border-amber-300/50 disabled:opacity-40 disabled:hover:border-white/10"
        >
          Restore
        </button>
        <button
          type="button"
          onClick={() => void dock.killTemp(temp.id)}
          className="rounded border border-white/10 px-1.5 py-0.5 text-xs uppercase tracking-wide hover:border-[#ff4a4a]/50 hover:text-still-fg"
        >
          Kill
        </button>
      </li>
    )
  }
  return (
    <>
      {dock.tempLayout.map((item) => (
        <TerminalOverlay
          key={item.id}
          open={dock.openTemps[item.id]}
          imageInsertStyle={imageInsertStyle}
          keyTextFor={keyTextFor}
          onClose={() => dock.minimizeTempFocus(item.id)}
          onNeedAuth={onNeedAuth}
          onOpenPalette={onOpenPalette}
          dockStyle={{
            ...(dock.openTempCount === 1
              ? { top: 0, height: "100vh", left: `calc(${dock.mainRatio * 100}vw + 1px)`, width: `calc(${(1 - dock.mainRatio) * 100}vw - 1px)` }
              : { top: item.top, height: item.height, left: "calc(50vw + 1px)", width: "calc(50vw - 1px)" }),
            // Direct manipulation: never let the 650ms open/close morph lag
            // behind the pointer or re-animate the final commit.
            transition: (dock.isResizing || dock.splitDrag.current) ? "none" : undefined,
          }}
          slot="right"
        />
      ))}

      {dock.tempLayout.slice(0, -1).map((item, i) => {
        const bottom = dock.tempLayout[i + 1]
        const pairHeight = item.height + bottom.height
        return (
          <div
            key={`resize-${item.id}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize temp terminals"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              pairHeight > 0 ? Math.round((item.height / pairHeight) * 100) : 50
            }
            data-temp-dock
            tabIndex={0}
            title="Drag to resize · arrow keys fine-tune"
            onPointerDown={dock.startResize(item.id, bottom.id)}
            onPointerMove={dock.moveResize}
            onPointerUp={dock.endResize}
            onPointerCancel={dock.endResize}
            onLostPointerCapture={dock.endResize}
            onKeyDown={dock.resizeKeyDown(item.id, bottom.id)}
            className="group fixed z-[65] flex touch-none select-none items-center justify-center"
            style={{
              top: bottom.top - 4,
              left: "calc(50vw + 1px)",
              width: "calc(50vw - 1px)",
              height: 8,
              cursor: "ns-resize",
              // Follow the same open/close redistribution as the tiles, but
              // stay glued to the pointer while the user is dragging.
              transition: dock.isResizing
                ? "none"
                : `top ${MORPH_MS}ms ${EASE}`,
            }}
          >
            <span
              aria-hidden
              className={`pointer-events-none h-[2px] rounded-full transition-[width,background-color] duration-150 ${
                dock.isResizing
                  ? "w-12 bg-amber-300/80"
                  : "w-7 bg-white/15 group-hover:w-11 group-hover:bg-amber-300/70 group-focus-visible:w-11 group-focus-visible:bg-amber-300/70"
              }`}
            />
          </div>
        )
      })}
      {dock.openTempCount === 1 && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal"
          aria-valuemin={30}
          aria-valuemax={80}
          aria-valuenow={Math.round(dock.mainRatio * 100)}
          data-temp-dock
          tabIndex={0}
          title="Drag to resize · arrow keys fine-tune"
          onPointerDown={dock.startSplit}
          onPointerMove={dock.moveSplit}
          onPointerUp={dock.endSplit}
          onPointerCancel={dock.endSplit}
          onKeyDown={dock.splitKeyDown}
          className="group fixed z-[65] flex touch-none select-none items-center justify-center"
          style={{
            top: 0,
            left: `calc(${dock.mainRatio * 100}vw - 4px)`,
            width: 8,
            height: "100vh",
            cursor: "ew-resize",
            transition: (dock.isResizing || dock.splitDrag.current) ? "none" : undefined,
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none h-full w-[2px] rounded-full transition-[width,background-color] duration-150 bg-white/10 group-hover:w-3 group-hover:bg-amber-300/70 group-focus-visible:w-3 group-focus-visible:bg-amber-300/70"
          />
        </div>
      )}


      {dock.tempDockMounted && (
        <div
          id="temp-pill"
          tabIndex={-1}
          data-temp-dock
          role="group"
          aria-label="Temp terminals"
          aria-hidden={dock.hasTemps ? undefined : true}
          inert={dock.hasTemps ? undefined : true}
          className={`temp-dock-peek ${dock.hasTemps ? "temp-dock-in" : "temp-dock-out"}`}
        >
          <span className="temp-dock-peek__rest" aria-hidden>
            <span className={`h-1.5 w-1.5 rounded-full temp-dock__dot ${tempAggregateDot(dock.dockTemps)}`} />
          </span>
          <div className="temp-dock-peek__reveal">
            {dock.dockTemps.length > 0 && (
              <ul className="temp-dock-peek__list">{dock.dockTemps.map((t) => tempRow(t))}</ul>
            )}
            <button type="button" className="temp-dock-peek__add" onClick={dock.toggleTemp}>
              + New
            </button>
          </div>
        </div>
      )}

    </>
  )
}

export type { OpenState }
void MORPH_MS
