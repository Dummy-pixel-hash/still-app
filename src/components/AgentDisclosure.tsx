import { useEffect, useRef, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"

/** Animate only deliberate disclosure; streamed content remains immediately readable. */
export default function AgentDisclosure({ summary, children, className, id }: { summary: ReactNode; children: ReactNode; className: string; id?: string }) {
  const details = useRef<HTMLDetailsElement>(null)
  const animation = useRef<Animation | null>(null)
  const target = useRef(false)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => () => { animation.current?.cancel() }, [])
  return <details ref={details} className={className} data-timeline-id={id} onToggle={event => {
    if (event.currentTarget.open) setRevealed(true)
    if (!animation.current) { const body = event.currentTarget.querySelector<HTMLElement>(":scope > .agent-disclosure-content"); if (body) body.inert = !event.currentTarget.open }
  }}>
    <summary onClick={event => {
      const element = details.current
      if (!element) return
      event.preventDefault()
      const open = animation.current ? !target.current : !element.open
      const start = element.getBoundingClientRect().height
      if (open && !revealed) flushSync(() => setRevealed(true))
      const body = element.querySelector<HTMLElement>(":scope > .agent-disclosure-content")
      animation.current?.cancel(); animation.current = null
      target.current = open
      element.open = open
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) { element.style.overflow = ""; if (body) body.inert = !open; return }
      const end = element.getBoundingClientRect().height
      element.open = true
      if (body) body.inert = !open
      element.style.overflow = "hidden"
      const next = element.animate([{ height: `${start}px` }, { height: `${end}px` }], { duration: 170, easing: "cubic-bezier(.16,1,.3,1)" })
      animation.current = next
      next.onfinish = () => { element.open = open; element.style.overflow = ""; animation.current = null }
    }}>{summary}</summary>
    <div className="agent-disclosure-content">{revealed && children}</div>
  </details>
}
