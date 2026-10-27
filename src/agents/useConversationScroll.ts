import { useCallback, useLayoutEffect, useRef, useState } from "react"

type Position = { id?: string; offset: number; top: number; mode: "following" | "reading" | "anchoring" }
const positions = new Map<string, Position>()

/** Keep a reader's stable message + offset, rather than guessing intent from new tokens. */
export function useConversationScroll(key: string, revision: unknown) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const position = useRef<Position>({ offset: 0, top: 0, mode: "following" })
  const frame = useRef(0), written = useRef<number | null>(null)
  const currentKey = useRef(key), turnFrame = useRef(0)
  currentKey.current = key
  const [atLatest, setAtLatest] = useState(true)
  const capture = useCallback(() => {
    const el = viewport.current, body = content.current
    if (!el || !body) return
    const edge = el.getBoundingClientRect().top
    const children = body.children
    let low = 0, high = children.length - 1
    while (low < high) { const mid = (low + high) >>> 1; if (children[mid].getBoundingClientRect().bottom <= edge) low = mid + 1; else high = mid }
    let node = children[low] as HTMLElement | undefined
    while (node && !node.dataset.timelineId) node = node.nextElementSibling as HTMLElement | undefined
    position.current = { ...position.current, id: node?.dataset.timelineId, offset: (node?.getBoundingClientRect().top ?? edge) - edge, top: el.scrollTop }
    positions.set(key, { ...position.current })
  }, [key])
  const correct = useCallback(() => {
    const el = viewport.current, body = content.current
    if (!el || !body) return
    const saved = position.current
    if (saved.mode === "following") el.scrollTop = el.scrollHeight
    else if (saved.id) {
      const node = body.querySelector<HTMLElement>(`[data-timeline-id="${CSS.escape(saved.id)}"]`)
      if (node) el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset
      else el.scrollTop = saved.top
    } else el.scrollTop = saved.top
    written.current = el.scrollTop
    position.current.top = el.scrollTop
    setAtLatest(el.scrollHeight - el.clientHeight - el.scrollTop < 48)
    if (saved.mode === "following") capture()
  }, [capture])
  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; correct() }) }, [correct])
  useLayoutEffect(() => {
    position.current = { ...(positions.get(key) || { offset: 0, top: 0, mode: "following" }) }
    correct()
    const observer = new ResizeObserver(schedule)
    if (viewport.current) observer.observe(viewport.current)
    if (content.current) observer.observe(content.current)
    return () => { positions.set(key, { ...position.current }); observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0; cancelAnimationFrame(turnFrame.current) }
  }, [key, capture, correct, schedule])
  useLayoutEffect(schedule, [revision, schedule])
  const onScroll = () => {
    const el = viewport.current
    if (!el) return
    if (written.current !== null && Math.abs(written.current - el.scrollTop) < 1) { written.current = null; return }
    written.current = null
    const latest = el.scrollHeight - el.clientHeight - el.scrollTop < 48
    position.current.mode = latest ? "following" : "reading"
    setAtLatest(latest); capture()
  }
  const follow = () => { position.current.mode = "following"; correct(); capture() }
  const anchorTurn = (conversationId = key) => {
    turnFrame.current = requestAnimationFrame(() => {
      if (currentKey.current !== conversationId) return
      const nodes = content.current?.querySelectorAll<HTMLElement>(".agent-message-user")
      const node = nodes?.[nodes.length - 1]
      if (!node) { follow(); return }
      position.current = { id: node.dataset.timelineId, offset: 20, top: viewport.current?.scrollTop || 0, mode: "anchoring" }
      correct()
    })
  }
  const onWheel = (event: React.WheelEvent) => {
    if (event.deltaY < 0) { position.current.mode = "reading"; written.current = null; capture() }
  }
  const jumpTo = (id: string) => {
    position.current = { id, offset: 20, top: viewport.current?.scrollTop || 0, mode: "reading" }
    correct(); capture(); viewport.current?.focus({ preventScroll: true })
  }
  const preparePrepend = () => { position.current.mode = "reading"; capture() }
  return { viewport, content, atLatest, onScroll, onWheel, follow, anchorTurn, jumpTo, preparePrepend }
}
