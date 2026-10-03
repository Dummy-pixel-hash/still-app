import { useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"

const MIN_PATH = "M6 15h12"
const MAX_PATH = "M6 6h12v12H6z"
const CLOSE_PATH = "M7 7l10 10M17 7L7 17"

/**
 * In-app window navigation: frameless-window controls rendered as a
 * floating, slightly oversized cluster (no title bar). The React renderer
 * owns the visuals; the native layer only performs the window action.
 */
export default function WindowNav() {
  const [action, setAction] = useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<void>) => {
    setAction(label)
    try {
      await fn()
    } catch {
      // Browser/mock path: keep the shell usable without native runtime.
    } finally {
      window.setTimeout(() => {
        setAction((current) => (current === label ? null : current))
      }, 600)
    }
  }

  const btn =
    "group flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/55 text-still-dim shadow-[0_2px_16px_rgba(0,0,0,0.5)] backdrop-blur transition-all duration-200 hover:scale-[1.06] hover:border-[#ff4a4a]/50 hover:text-still-fg hover:shadow-[0_0_18px_rgba(255,74,74,0.25)] active:scale-95"

  const icon =
    "h-[18px] w-[18px] transition-transform duration-200 group-hover:scale-110"

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-30 flex items-center gap-2.5">
      <div
        data-tauri-drag-region
        className="pointer-events-auto h-11 flex-1 cursor-default rounded-full border border-white/[0.07] bg-black/30 backdrop-blur"
        aria-hidden
      />
      {action ? (
        <span className="pointer-events-auto font-mono text-[10px] uppercase tracking-[0.2em] text-still-faint">
          {action}…
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        className={`${btn} pointer-events-auto`}
        onClick={() => void run("minimize", () => nativeBridge.windowMinimize())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className={icon} aria-hidden>
          <path d={MIN_PATH} />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Maximize or restore"
        title="Maximize / restore"
        className={`${btn} pointer-events-auto`}
        onClick={() =>
          void run("maximize", () => nativeBridge.windowToggleMaximize())
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={icon} aria-hidden>
          <path d={MAX_PATH} />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        className={`${btn} pointer-events-auto hover:!border-[#ff4a4a]/70 hover:!bg-[#ff4a4a]/15 hover:!text-[#ff6b6b] hover:!shadow-[0_0_22px_rgba(255,74,74,0.4)]`}
        onClick={() => void run("close", () => nativeBridge.windowClose())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className={icon} aria-hidden>
          <path d={CLOSE_PATH} />
        </svg>
      </button>
    </div>
  )
}
