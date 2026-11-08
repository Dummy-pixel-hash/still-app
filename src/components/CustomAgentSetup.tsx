import { useRef, useState } from "react"
import "../styles/custom-agents.css"
import { customAgentError } from "../agents/customAgents"
import type { AgentAvailability, CustomAgent } from "../agents/types"

type Props = {
  agent: CustomAgent
  serverName: string
  connected: boolean
  onTest: (agent: CustomAgent) => Promise<AgentAvailability[]>
  onSave: (agent: CustomAgent) => void
  onClose: () => void
}

export default function CustomAgentSetup({ agent, serverName, connected, onTest, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(agent)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")
  const operation = useRef(0)
  const update = (patch: Partial<CustomAgent>) => {
    operation.current++
    setDraft(old => ({ ...old, ...patch })); setStatus(""); setError("")
  }
  const normalized = () => ({ ...draft, name: draft.name.trim(), executable: draft.executable.trim() })
  const test = async () => {
    const candidate = normalized(), invalid = customAgentError(candidate, agent.hostKey)
    if (invalid) { setError(invalid); return }
    const revision = ++operation.current
    setBusy(true); setError(""); setStatus("Testing ACP connection…")
    try {
      const result = (await onTest(candidate)).find(row => row.agentId === candidate.id)
      if (revision !== operation.current) return
      if (result?.available) setStatus("Ready — ACP connection verified.")
      else { setStatus(""); setError(result?.message || (result?.installed ? "ACP connection unavailable." : "Executable not found on this server.")) }
    } catch (failure) {
      if (revision === operation.current) { setStatus(""); setError(failure && typeof failure === "object" && "message" in failure ? String(failure.message) : String(failure)) }
    } finally { if (revision === operation.current) setBusy(false) }
  }
  return <div className="agent-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <form className="agent-modal agent-custom-setup" role="dialog" aria-modal="true" aria-labelledby="custom-agent-heading" onKeyDown={event => { if (event.key === "Escape" && busy) event.stopPropagation() }} onSubmit={event => {
      event.preventDefault()
      const candidate = normalized(), invalid = customAgentError(candidate, agent.hostKey)
      if (invalid) { setError(invalid); return }
      onSave(candidate)
    }}>
      <h2 id="custom-agent-heading">{agent.name ? "Edit custom agent" : "Add custom agent"}</h2>
      <p>Connect a CLI that speaks ACP over stdio. Install and sign in to it on this server first.</p>
      <label className="agent-field">Server<input value={serverName} readOnly /></label>
      <fieldset disabled={busy}>
        <label className="agent-field">Name<input aria-label="Custom agent name" value={draft.name} maxLength={80} onChange={event => update({ name: event.target.value })} placeholder="My coding agent" required /></label>
        <label className="agent-field">Executable<input aria-label="Custom agent executable" value={draft.executable} maxLength={4096} onChange={event => update({ executable: event.target.value })} placeholder="my-agent or /opt/agents/my-agent" required /><span>A command on the server’s PATH or an absolute remote path. No shell commands.</span></label>
        <div className="agent-custom-arguments"><h3>Arguments</h3><p>Each row is one literal argument, in order. Do not add shell quotes.</p>
          {draft.args.map((arg, index) => <div className="agent-custom-argument" key={index}><label className="agent-field"><span>Argument {index + 1}</span><input aria-label={`Argument ${index + 1}`} value={arg} maxLength={4096} onChange={event => update({ args: draft.args.map((value, i) => i === index ? event.target.value : value) })} /></label><button className="agent-button" type="button" aria-label={`Remove argument ${index + 1}`} onClick={() => update({ args: draft.args.filter((_, i) => i !== index) })}>Remove</button></div>)}
          <button className="agent-button" type="button" disabled={draft.args.length >= 64} onClick={() => update({ args: [...draft.args, ""] })}>Add argument</button>
        </div>
        <label className="agent-field">Protocol<input value="ACP over stdio" readOnly /></label>
      </fieldset>
      <p className="agent-custom-test-note">Testing launches this executable on {serverName}, negotiates ACP, then stops it. No conversation or prompt is created.</p>
      <p role="status" aria-live="polite">{status || "Not tested. You can save now and connect when starting a conversation."}</p>
      {error && <p className="agent-error" role="alert">{error}</p>}
      <div className="agent-inline-actions"><button className="agent-button" type="button" disabled={!connected || busy} onClick={() => void test()}>{busy ? "Testing…" : "Test connection"}</button><button className="agent-primary" type="submit" disabled={busy}>Save agent</button><button className="agent-button" type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </div>
}
