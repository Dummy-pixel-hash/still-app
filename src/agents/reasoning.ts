import type { AgentConfigOptionValue } from "./types"

type ReasoningStep = { tier: "low" | "middle" | "high" | "ultra"; option: AgentConfigOptionValue }
const label = (option: AgentConfigOptionValue) => `${option.name} ${option.value}`.toLowerCase().replace(/[_-]+/g, " ")
function rank(option: AgentConfigOptionValue) {
  const text = label(option)
  if (/\bultra\b/.test(text)) return 4
  if (/\b(?:vhigh|xhigh|max|maximum)\b|(?:very|extra)\s*high/.test(text)) return 3
  if (/\bhigh\b/.test(text)) return 2
  if (/\b(?:med|medium)\b/.test(text)) return 1
  if (/\b(?:low|lowest|minimal|minimum|min|none|off)\b/.test(text)) return 0
  return null
}

/** At most three normal effort presets, plus Ultra only when explicitly reported. */
export function reasoningScale(reported: AgentConfigOptionValue[], currentValue: string | boolean) {
  const choices = reported.filter((option, index) => reported.findIndex(other => other.value === option.value) === index)
  const ordinary = choices.filter(option => rank(option) !== 4)
  const ultra = choices.filter(option => rank(option) === 4).at(-1)
  const low = ordinary.find(option => /\b(?:low|lowest)\b/.test(label(option))) || ordinary.find(option => rank(option) === 0) || ordinary[0]
  const high = ordinary.filter(option => rank(option) === 3).at(-1) || ordinary.filter(option => rank(option) === 2).at(-1) || ordinary.at(-1)
  const between = low && high ? ordinary.slice(ordinary.indexOf(low) + 1, ordinary.indexOf(high)) : []
  const remaining = ordinary.filter(option => option !== low && option !== high)
  const middle = remaining.find(option => rank(option) === 2) || remaining.find(option => rank(option) === 1) || between[Math.floor(between.length / 2)]
  const steps: ReasoningStep[] = []
  const add = (tier: ReasoningStep["tier"], option?: AgentConfigOptionValue) => {
    if (option && !steps.some(step => step.option.value === option.value)) steps.push({ tier, option })
  }
  add("low", low); add("middle", middle); add("high", high); add("ultra", ultra)
  const current = choices.find(option => option.value === currentValue)
  let active = steps.findIndex(step => step.option.value === currentValue)
  if (current && active < 0) {
    const level = rank(current)
    const tier = level === 4 ? "ultra" : level === 3 ? "high" : level === 1 || level === 2 ? "middle" : level === 0 ? "low" : null
    active = tier ? steps.findIndex(step => step.tier === tier) : -1
    if (active < 0 && current.value !== "" && !/\b(?:auto|default)\b/.test(label(current))) {
      const index = choices.indexOf(current)
      const lower = steps.filter(step => step.tier !== "ultra" && choices.indexOf(step.option) <= index).at(-1)
      active = lower ? steps.indexOf(lower) : steps.length ? 0 : -1
    }
  }
  return { steps, active }
}
