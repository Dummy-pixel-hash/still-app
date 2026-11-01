import { useEffect, useRef, useState } from "react"
import type { AgentConfigOption, AgentConfigOptionValue } from "../agents/types"
import { configValues } from "./AgentControls"

const tierLabels = ["Lowest reasoning", "Medium or high reasoning", "Very high or max reasoning", "Ultra reasoning"]

function tierFor(value: AgentConfigOptionValue) {
  const label = `${value.name} ${value.value}`.toLowerCase().replace(/[_-]+/g, " ")
  if (/\bultra\b|\bextreme\b/.test(label)) return 3
  if (/very\s*high|\bvhigh\b|\bxhigh\b|extra\s*high|\bmaximum\b|\bmax\b/.test(label)) return 2
  if (/\bmedium\b|\bmed\b|\bhigh\b/.test(label)) return 1
  if (/\blowest\b|\bminimal\b|\bminimum\b|\blow\b|\bnone\b|\boff\b/.test(label)) return 0
  return -1
}

function groupsFor(values: AgentConfigOptionValue[]) {
  const groups: AgentConfigOptionValue[][] = [[], [], [], []]
  values.forEach((value, index) => {
    const tier = tierFor(value)
    const fallbackTier = values.length <= 4 ? index : Math.min(3, Math.floor(index * 4 / values.length))
    groups[tier < 0 ? fallbackTier : tier].push(value)
  })
  if (groups[0].length === 0) {
    const firstAvailable = groups.findIndex(group => group.length > 0)
    if (firstAvailable > 0) groups[0].push(groups[firstAvailable].shift()!)
  }
  return groups
}

type Props = {
  option: AgentConfigOption
  disabled: boolean
  disabledReason?: string
  change: (id: string, value: string) => void | Promise<void>
}

/** Four coarse reasoning levels; each bar selects its representative advertised effort. */
export default function AgentReasoningBars({ option, disabled, disabledReason, change }: Props) {
  const values = configValues(option)
  const groups = groupsFor(values)
  const active = groups.findIndex(group => group.some(value => value.value === option.currentValue))
  const current = groups.flat().find(value => value.value === option.currentValue)
  const [pending, setPending] = useState<string | null>(null)
  const inFlight = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (values.length < 2) return null
  const choose = async (tier: number) => {
    const group = groups[tier]
    if (!group?.length || disabled || inFlight.current) return
    const target = (tier === 0 ? group[0] : group.at(-1))!
    if (target.value === option.currentValue) return
    inFlight.current = true
    if (mounted.current) setPending(target.value)
    try { await change(option.id, target.value) }
    catch { /* The workspace surfaces configuration failures beside the composer. */ }
    finally { inFlight.current = false; if (mounted.current) setPending(null) }
  }
  return <div className="agent-reasoning-control" role="group" aria-label="Reasoning effort" aria-description={current ? `${current.name} selected` : undefined} aria-busy={pending !== null} title={disabled ? disabledReason : current ? `${option.name}: ${current.name}` : "Reasoning effort"}>
    {[0, 1, 2, 3].map(tier => {
      const group = groups[tier], available = !!group?.length, name = group?.map(value => value.name).join(" or ")
      return <button key={tier} type="button" className={`agent-reasoning-level${available && active >= 0 && tier <= active ? " is-filled" : ""}${available && active === tier ? " is-current" : ""}${available ? "" : " is-unavailable"}`} aria-label={name ? `${name} reasoning` : `${tierLabels[tier]} is not available`} aria-pressed={available ? active === tier : undefined} title={disabled ? disabledReason : available ? `${option.name}: ${name}` : `${tierLabels[tier]} is not available for this model`} disabled={disabled || !available} onClick={() => void choose(tier)}><span aria-hidden="true" /></button>
    })}
  </div>
}
