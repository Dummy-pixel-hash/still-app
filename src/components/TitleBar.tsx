import { useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"

const MIN = "–"
const MAX = "□"
const CLOSE = "×"

/**
 * Frameless caption surface. The React renderer owns the visual shell;
 * the native layer only performs the requested window action.
 */
export default function TitleBar({
  title = "Still",
  subtitle,
}: {
  title?: string
  subtitle?: string
}) {
  const [action, setAction] = useState<string | null>(null)

  const run = async (label: string, fn: () => Promise<void>) => {
    setAction(label)
    try {
      await fn()
    } catch {
      // Placeholder path: keep the shell usable.
    } finally {
      window.setTimeout(() => {
        setAction((current) => (current === label ? null : current))
      }, 600)
    }
  }

  const btn =
    "flex h-7 w-9 items-center justify-center font-mono text-[12px] text-still-faint transition hover:bg-white/[0.07] hover:text-still-fg"

  return (
    <header className="relative z-20 flex h-10 shrink-0 select-none items-stretch border-b border-white/[0.06] bg-black/50">
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 cursor-default items-center gap-3 px-4"
        onDoubleClick={() =>
          void run("maximize", () => nativeBridge.windowToggleMaximize())
        }
      >
        <span className="font-serif text-[17px] tracking-wide text-still-fg">
          {title}
        </span>
        {subtitle ? (
          <span className="hidden truncate font-mono text-[10px] uppercase tracking-[0.2em] text-still-faint sm:inline">
            {subtitle}
          </span>
        ) : null}
        {action ? (
          <span className="font-mono text-[10px] text-still-faint">
            {action}…
          </span>
        ) : null}
      </div>
      <div className="flex items-stretch">
        <button
          type="button"
          aria-label="Minimize"
          className={btn}
          onClick={() => void run("minimize", () => nativeBridge.windowMinimize())}
        >
          {MIN}
        </button>
        <button
          type="button"
          aria-label="Maximize or restore"
          className={btn}
          onClick={() =>
            void run("maximize", () => nativeBridge.windowToggleMaximize())
          }
        >
          {MAX}
        </button>
        <button
          type="button"
          aria-label="Close"
          className={`${btn} hover:!bg-[#b3161c] hover:!text-white`}
          onClick={() => void run("close", () => nativeBridge.windowClose())}
        >
          {CLOSE}
        </button>
      </div>
    </header>
  )
}
