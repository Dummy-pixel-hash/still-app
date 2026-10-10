import type { Terminal } from "@xterm/xterm"

/** Convert continuous touchpad deltas to discrete terminal wheel steps. */
export class WheelSteps {
  private remainder = 0
  private lastTime = 0

  reset(): void { this.remainder = 0 }

  consume(delta: number, mode: number, cellHeight: number, rows: number, now = performance.now()): number {
    if (!Number.isFinite(delta) || !Number.isFinite(cellHeight) || cellHeight <= 0) return 0
    if (now - this.lastTime > 250 || delta * this.remainder < 0) this.reset()
    this.lastTime = now
    const lines = mode === 0 ? delta / cellHeight : mode === 2 ? delta * rows : delta
    this.remainder += lines
    const whole = Math.trunc(this.remainder)
    this.remainder -= whole
    // A malformed/extreme event must not queue seconds of key/mouse reports.
    return Math.max(-32, Math.min(32, whole))
  }
}

/**
 * xterm 6's application-wheel path dampens small pixel events by 0.3 and
 * discards the magnitude after calculating a line count (one report/event).
 * Normalize only that path; leave normal local scrollback to xterm's viewport.
 * Re-dispatch line steps through xterm so it still owns mouse protocol encoding,
 * coordinates and alternate-buffer cursor-key modes. No private xterm APIs.
 */
export function bindApplicationWheel(
  terminal: Terminal,
  host: HTMLElement,
  batchInput: (dispatch: () => void) => void,
): () => void {
  const steps = new WheelSteps()
  const forwarded = new WeakSet<Event>()
  const element = terminal.element!
  const screen = element.querySelector<HTMLElement>(".xterm-screen")!
  const onWheel = (event: WheelEvent) => {
    if (forwarded.has(event)) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      steps.reset()
      return // Pinch/modifier gestures are not ordinary scrolling.
    }
    if (!(event.target instanceof Node) || !element.contains(event.target)) return
    // Normal buffer: hands off. xterm checks scrollback before mouse
    // reports, so the viewport scrolls natively with zero IPC. Forwarding
    // here is what dragged every tick into tmux copy-mode.
    if (terminal.buffer.active.type !== "alternate") {
      steps.reset()
      return
    }
    const rowHeight = screen.getBoundingClientRect().height / terminal.rows
    if (rowHeight <= 0) return
    const count = steps.consume(event.deltaY, event.deltaMode, rowHeight, terminal.rows)
    event.preventDefault()
    event.stopImmediatePropagation()
    batchInput(() => {
      for (let i = 0; i < Math.abs(count); i++) {
        const normalized = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: Math.sign(count),
          clientX: event.clientX,
          clientY: event.clientY,
        })
        forwarded.add(normalized)
        element.dispatchEvent(normalized)
      }
    })
  }
  host.addEventListener("wheel", onWheel, { capture: true, passive: false })
  return () => host.removeEventListener("wheel", onWheel, { capture: true })
}
