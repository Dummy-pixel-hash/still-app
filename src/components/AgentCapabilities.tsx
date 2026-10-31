import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { AgentCapabilityKey, AgentCapabilityReport, AgentFeatureSupport, AgentProviderTransport } from "../agents/types"
import { useAgentPopover } from "../agents/useAgentPopover"
import AgentIcon from "./AgentIcon"

type Props = {
  open?: boolean
  report?: AgentCapabilityReport
  providerLabel: string
  state: "connecting" | "live" | "offline" | "unavailable"
  refresh?: () => Promise<void>
  close: () => void
}

const features: Array<{ key: AgentCapabilityKey; label: string }> = [
  { key: "sharedTodos", label: "Agent-managed Todos" },
  { key: "providerPlans", label: "Provider plan snapshots" },
  { key: "providerTaskProjection", label: "Native task synchronization" },
  { key: "clientTodoWrite", label: "Manual Todo editing" },
]

const transportLabels: Record<AgentProviderTransport, string> = {
  "http-v2+sse": "OpenCode server · HTTP/SSE",
  "codex-app-server": "Codex app server",
  "claude-stream-json": "Claude stream JSON",
  "pi-rpc": "Pi RPC",
  "acp-v1": "Agent Client Protocol (ACP v1)",
}

export function agentProviderTransportLabel(transport?: AgentProviderTransport) {
  return transport ? transportLabels[transport] || "Transport not reported" : "Transport not reported"
}

function statusLabel(status: AgentFeatureSupport["status"]) {
  return status === "supported" ? "Supported" : status === "unsupported" ? "Unavailable" : "Not verified"
}

function featureReason(key: AgentCapabilityKey, feature: AgentFeatureSupport, report: AgentCapabilityReport) {
  if (key === "sharedTodos" && feature.evidence === "advertised") return "Tool connected. A tool call has not been observed yet."
  if (key === "sharedTodos" && feature.evidence === "observed") return "A Todo tool call was observed in this configuration."
  if (key === "sharedTodos" && feature.status === "unverified" && report.configGeneration > 0) return "Settings changed. Tool-call evidence has not been observed for this configuration."
  if (key === "providerPlans" && feature.status === "unverified") return "Waiting for this session to report a structured plan."
  if (key === "providerTaskProjection") return "Native provider tasks are not synchronized here."
  if (key === "clientTodoWrite") return "The agent manages task names and Done/Not done status."
  return feature.reason
}

export default function AgentCapabilities({ open = true, report, providerLabel, state, refresh, close }: Props) {
  const popup = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true), refreshing = useRef(false)
  const [refreshingUi, setRefreshingUi] = useState(false), [refreshError, setRefreshError] = useState("")
  const headingId = useId()
  useAgentPopover(popup, open, "end", true)
  useLayoutEffect(() => { if (open) closeButton.current?.focus({ preventScroll: true }) }, [open])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const refreshReport = async () => {
    if (!refresh || refreshing.current) return
    refreshing.current = true; setRefreshingUi(true); setRefreshError("")
    try { await refresh() }
    catch { if (mounted.current) setRefreshError("Could not refresh capability details. Try again.") }
    finally { refreshing.current = false; if (mounted.current) setRefreshingUi(false) }
  }

  const observation = state === "connecting"
    ? "Checking this connection…"
    : report
      ? report.freshness === "current" && state === "live" ? "Current connection" : "Last observed on this connection · stale"
      : "This execution does not report capability details."
  const featureRows = report
    ? features.map(({ key, label }) => {
      const feature = report.features?.[key]
      return {
        key,
        label,
        status: state === "connecting" || !feature ? "Not verified" : statusLabel(feature.status),
        reason: state === "connecting" ? "Waiting for this connection to report current evidence." : feature ? featureReason(key, feature, report) : "No evidence was reported for this feature.",
      }
    })
    : state === "connecting"
      ? features.map(({ key, label }) => ({ key, label, status: "Not verified", reason: "Waiting for this connection to report current evidence." }))
      : []

  if (!open) return null
  return <div ref={popup} id="agent-capabilities-popover" className="agent-capabilities-popover" role="dialog" aria-labelledby={headingId} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <header className="agent-capabilities-heading">
      <div>
        <h2 id={headingId}>Supported by this agent</h2>
        <p>{providerLabel}</p>
      </div>
      <button ref={closeButton} type="button" className="agent-icon-button" aria-label="Close agent details" title="Close agent details" onClick={close}><AgentIcon name="close" size={15} /></button>
    </header>
    <dl className="agent-capabilities-runtime">
      <div><dt>Version</dt><dd>{report?.providerRuntime.version || "Version not reported"}</dd></div>
      <div><dt>Transport</dt><dd>{agentProviderTransportLabel(report?.providerRuntime.transport)}</dd></div>
      {report?.providerRuntime.executable && <div className="agent-capabilities-executable"><dt>Executable</dt><dd><code>{report.providerRuntime.executable}</code></dd></div>}
    </dl>
    <p className={`agent-capabilities-observation${report?.freshness === "stale" || state === "offline" ? " is-stale" : ""}`} role="status">{observation}</p>
    {featureRows.length ? <dl className="agent-capabilities-features">
      {featureRows.map(feature => <div className="agent-capability-feature" key={feature.key}>
        <dt>{feature.label}</dt>
        <dd><strong>{feature.status}</strong><span>{feature.reason}</span></dd>
      </div>)}
    </dl> : null}
    {refreshError && <p className="agent-capabilities-error" role="alert">{refreshError}</p>}
    <footer className="agent-capabilities-actions">
      {refresh && <button type="button" className="agent-button" disabled={refreshingUi} onClick={() => void refreshReport()}>
        <AgentIcon name="refresh" size={14} />{refreshingUi ? "Refreshing…" : "Refresh report"}
      </button>}
    </footer>
  </div>
}
