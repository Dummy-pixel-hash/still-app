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
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch {
      // Browser/mock path: keep the shell usable without native runtime.
    }
  }

  const btn =
    "flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/55 text-still-dim transition-colors duration-200 hover:border-white/30 hover:text-still-fg"

  const icon = "h-[18px] w-[18px]"

  return (
    <div className="pointer-events-none absolute left-4 right-4 top-4 z-30 flex items-center gap-2.5">
      <div
        data-tauri-drag-region
        className="pointer-events-auto h-11 flex-1 cursor-default rounded-full border border-white/[0.07] bg-black/30"
        aria-hidden
      />
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        className={`${btn} pointer-events-auto`}
        onClick={() => void run(() => nativeBridge.windowMinimize())}
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
        onClick={() => void run(() => nativeBridge.windowToggleMaximize())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={icon} aria-hidden>
          <path d={MAX_PATH} />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        className={`${btn} pointer-events-auto hover:!border-[#ff4a4a]/70 hover:!bg-[#ff4a4a]/15 hover:!text-[#ff6b6b]`}
        onClick={() => void run(() => nativeBridge.windowClose())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className={icon} aria-hidden>
          <path d={CLOSE_PATH} />
        </svg>
      </button>
    </div>
  )
}
