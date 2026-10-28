import AgentIcon from "./AgentIcon"

/** Provider-owned marks identify the executable; they are not Still's branding. */
export default function AgentProviderMark({ id, size = 18 }: { id: string; size?: number }) {
  const provider = id.toLowerCase()
  const name = /claude/.test(provider) ? "claude" : /codex|openai/.test(provider) ? "codex" : /opencode/.test(provider) ? "opencode" : provider
  if (["claude", "codex", "opencode"].includes(name)) return <img className={`agent-provider-mark is-${name}`} width={size} height={size} src={`/agents/${name}.svg`} alt="" aria-hidden="true" />
  if (name === "pi") return <span className="agent-provider-mark is-pi" style={{ width: size, height: size, fontSize: size }} aria-hidden="true">π</span>
  if (name === "gemini") return <svg className="agent-provider-mark is-gemini" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1c1.4 7.3 3.7 9.6 11 11-7.3 1.4-9.6 3.7-11 11C10.6 15.7 8.3 13.4 1 12c7.3-1.4 9.6-3.7 11-11Z" /></svg>
  return <AgentIcon name="terminal" size={size} />
}

export function StillAgentMark({ size = 44 }: { size?: number }) {
  return <svg className="still-agent-mark" width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M34 10H19c-6 0-10 3.5-10 8s3 6 8 6h13c5 0 8 2.5 8 7s-4 7-10 7H13" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    <path d="m30 5 6 5-6 5M18 33l-6 5 6 5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
