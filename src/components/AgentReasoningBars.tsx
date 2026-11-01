import { useEffect, useId, useRef, useState, type CSSProperties } from "react"
import type { AgentConfigOption } from "../agents/types"
import { configValues } from "./AgentControls"

type Props = {
  option: AgentConfigOption
  disabled: boolean
  disabledReason?: string
  change: (id: string, value: string) => Promise<void>
}

/** One bar per advertised choice, in provider order. Never infer or merge effort levels. */
export default function AgentReasoningBars({ option, disabled, disabledReason, change }: Props) {
  const values = configValues(option)
  const active = values.findIndex(value => value.value === option.currentValue)
  const current = values[active]
  const [pending, setPending] = useState<string | null>(null), [error, setError] = useState("")
  const inFlight = useRef(false), mounted = useRef(true)
  const feedbackId = useId()
  const choicesKey = JSON.stringify(values.map(value => value.value))
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setError("") }, [choicesKey, option.id])
  const readonly = disabled || pending !== null || values.length < 2
  const choose = async (index: number) => {
    const target = values[index]
    if (!target || readonly || inFlight.current || target.value === option.currentValue) return
    inFlight.current = true
    setPending(target.value); setError("")
    try { await change(option.id, target.value) }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { inFlight.current = false; if (mounted.current) setPending(null) }
  }
  if (option.type !== "select" || !values.length) return null
  const next = (active + 1) % values.length
  return <div className="agent-reasoning-control" aria-busy={pending !== null}>
    <button type="button" className="agent-reasoning-trigger" aria-label={`Reasoning effort: ${current?.name || String(option.currentValue)}`} aria-description={pending !== null ? "Updating reasoning." : disabled ? disabledReason : `${values.length} available levels. Click to change to ${values[next].name}.`} aria-describedby={error ? feedbackId : undefined} aria-disabled={readonly} onClick={() => void choose(next)}>
      {values.map((value, index) => <span key={value.value} className={`agent-reasoning-level${index <= active ? " is-filled" : ""}`} aria-hidden="true" data-reasoning-value={value.value} data-reasoning-label={value.name} style={{ height: values.length === 1 ? 12 : 8 + index * 10 / (values.length - 1), "--effort-index": index } as CSSProperties} />)}
    </button>
    <span className="agent-sr-only" aria-live="polite" aria-atomic="true">{pending !== null ? `Setting reasoning to ${values.find(value => value.value === pending)?.name || pending}…` : ""}</span>
    {error && <span id={feedbackId} className="agent-reasoning-error" role="alert">{error}</span>}
  </div>
}
