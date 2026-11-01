import { useEffect, useLayoutEffect, useRef } from "react"

type Frame = { left: number; top: number; width: number; height: number }

/** Morph only the glass shell. Text is laid out at its final width before measurement. */
export function useComposerMotion(collapsed: boolean, expanded: boolean, change: (expanded: boolean) => void) {
  const form = useRef<HTMLFormElement>(null)
  const from = useRef<Frame | null>(null)
  const animations = useRef<Animation[]>([])
  const stop = () => { animations.current.forEach(animation => animation.cancel()); animations.current = [] }
  const setExpanded = (next: boolean) => {
    if (next === expanded) return
    const element = form.current
    if (element) {
      const rect = element.getBoundingClientRect()
      const transform = getComputedStyle(element, "::before").transform
      const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform)
      from.current = { left: rect.left + matrix.e, top: rect.top + matrix.f, width: rect.width * matrix.a, height: rect.height * matrix.d }
    }
    stop()
    change(next)
  }
  useLayoutEffect(() => {
    const element = form.current, previous = from.current
    from.current = null
    if (!element || !previous || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const easing = "cubic-bezier(.22, .75, .25, 1)"
    try {
      const effect = new KeyframeEffect(element, [
        { transform: `translate(${previous.left - rect.left}px, ${previous.top - rect.top}px) scale(${previous.width / rect.width}, ${previous.height / rect.height})` },
        { transform: "none" },
      ], { pseudoElement: "::before", duration: collapsed ? 340 : 420, easing })
      const shell = new Animation(effect, document.timeline)
      shell.play()
      animations.current.push(shell)
    } catch { /* WebViews without pseudo-element animation keep the content crossfade. */ }
    for (const child of element.querySelectorAll<HTMLElement>(".agent-composer-toolbar, textarea")) {
      if (collapsed && child.tagName === "TEXTAREA") continue
      animations.current.push(child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: collapsed ? 35 : 70, fill: "backwards", easing }))
    }
  }, [collapsed])
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)")
    const reduce = () => { if (query.matches) stop() }
    query.addEventListener("change", reduce)
    return () => { query.removeEventListener("change", reduce); stop() }
  }, [])
  return { form, setExpanded }
}
