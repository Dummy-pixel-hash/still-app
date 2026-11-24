import { useEffect, useState } from "react"
import type { Terminal } from "@xterm/xterm"

/**
 * "New output below" jump button. Appears only when the reader has scrolled
 * away from the bottom AND output has arrived since, so it never nags a
 * reader who is simply browsing scrollback of an idle session.
 */
export default function NewOutputButton({ terminal }: { terminal: Terminal }) {
  const [unseen, setUnseen] = useState(false)

  useEffect(() => {
    const atBottom = () => {
      const b = terminal.buffer.active
      return b.viewportY >= b.baseY
    }
    const onScroll = () => {
      if (atBottom()) setUnseen(false)
    }
    // Any parsed write while scrolled up means new content below the viewport.
    const onWrite = () => {
      if (!atBottom()) setUnseen(true)
    }
    const a = terminal.onScroll(onScroll)
    const w = terminal.onWriteParsed(onWrite)
    return () => {
      a.dispose()
      w.dispose()
    }
  }, [terminal])

  if (!unseen) return null
  return (
    <button
      type="button"
      data-testid="new-output"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        terminal.scrollToBottom()
        setUnseen(false)
        terminal.focus()
      }}
      className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/15 bg-[#17171a] px-4 py-1.5 text-xs text-fg shadow-[0_8px_24px_rgba(0,0,0,0.6)] transition hover:bg-[#1f1f23]"
    >
      New output below
    </button>
  )
}
