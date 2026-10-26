import { useEffect, useMemo, useRef, useState } from "react"
import { AGENTS, type AgentAvailability, type AgentConfigOption, type AgentLaunchOptions, type AgentPermissionOption } from "../agents/types"
import { conversation } from "../agents/transcript"
import { cancelAgentTurn, refreshAgentThread, respondAgentPermission, sendAgentMessage, setAgentConfig, subscribeRemoteAgent, useAgentThreads, type AgentThreadRow } from "../session/agentThreads"
import type { Session } from "../types"
import { AgentMessage, AgentToolResult } from "./AgentMessage"
import "../styles/agent-workspace.css"

type Props = {
  session: Session
  onClose: () => void
  onOpenTerminal?: () => void
  onStart: (agentId: string, options?: AgentLaunchOptions) => Promise<AgentThreadRow>
  onCheck: (agentId?: string, executable?: string) => Promise<AgentAvailability[]>
}
function eventTitle(row: AgentThreadRow) { return row.transcript.find(e => e.type === "userMessage")?.text || `${row.agentName} thread` }
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String(error.message)
  return typeof error === "string" ? error : "The remote operation failed. Check the server terminal before retrying."
}
function status(row: AgentThreadRow) {
  if (row.pendingPermission) return "Needs approval"
  if (row.state === "connecting") return "Connecting"
  if (row.state === "submissionUnknown") return "Connection uncertain"
  if (row.state === "error") return "Unavailable"
  if (row.turnActive) return "Working"
  if (row.state === "cancelled") return "Stopped"
  return "Ready"
}
const idle = (row: AgentThreadRow | null) => !!row && !row.turnActive && ["working", "complete", "cancelled"].includes(row.state)

function ConfigControl({ option, disabled, change }: { option: AgentConfigOption; disabled: boolean; change: (id: string, value: string | boolean) => void }) {
  const options = option.options || []
  const values = options.flatMap(value => "value" in value ? [value.value] : value.options.map(v => v.value))
  return <label className="agent-config" title={option.description}>
    <span>{option.name}</span>
    {option.type === "select" ? <select aria-label={option.name} value={String(option.currentValue)} disabled={disabled} onChange={e => change(option.id, e.target.value)}>
      {!values.includes(String(option.currentValue)) && <option value={String(option.currentValue)}>{String(option.currentValue)}</option>}
      {options.map((value, i) => "value" in value
        ? <option key={value.value} value={value.value}>{value.name}</option>
        : <optgroup key={i} label={value.name}>{value.options.map(v => <option key={v.value} value={v.value}>{v.name}</option>)}</optgroup>)}
    </select> : <span className="agent-config-readonly">{String(option.currentValue)} · unsupported control</span>}
  </label>
}

export default function AgentWorkspace({ session, onClose, onOpenTerminal = onClose, onStart, onCheck }: Props) {
  const threads = useAgentThreads().filter(row => row.localSessionId === session.id)
  const [selected, setSelected] = useState<string | null>(() => threads[0]?.executionId || null)
  const [agent, setAgent] = useState("opencode")
  const [cwd, setCwd] = useState(session.workingDirectory)
  const [executables, setExecutables] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [configBusy, setConfigBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [availability, setAvailability] = useState<Record<string, AgentAvailability>>({})
  const [error, setError] = useState<string | null>(null)
  const [setup, setSetup] = useState(false)
  const [sidebar, setSidebar] = useState(false)
  const [showCommands, setShowCommands] = useState(false)
  const [following, setFollowing] = useState(true)
  const log = useRef<HTMLDivElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const surface = useRef<HTMLElement>(null)
  const current = threads.find(row => row.executionId === selected) || null
  const draftKey = selected || "new"
  const draft = drafts[draftKey] || ""
  const setDraft = (text: string) => setDrafts(all => ({ ...all, [draftKey]: text }))
  const definition = AGENTS.find(a => a.id === agent)!
  const items = useMemo(() => conversation(current?.transcript || []), [current?.transcript])
  const plan = current?.transcript.slice().reverse().find(e => e.type === "plan")?.plan
  const canSend = idle(current) && !busy && !configBusy && !!draft.trim()

  useEffect(() => {
    if (selected) void subscribeRemoteAgent(selected)
    setFollowing(true); setError(null); setShowCommands(false)
  }, [selected])
  useEffect(() => {
    if (following && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [current?.lastSequence, selected, following, setup])
  useEffect(() => {
    const field = prompt.current
    if (field) { field.style.height = "auto"; field.style.height = `${Math.min(field.scrollHeight, 180)}px` }
  }, [draft, selected])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    surface.current?.focus()
    return () => previous?.focus()
  }, [])

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await operation() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  const check = async (onlySelected = false) => {
    setChecking(true); setError(null)
    try {
      const results = onlySelected
        ? await onCheck(agent, executables[agent]?.trim() || undefined)
        : (await Promise.all(AGENTS.map(provider => onCheck(provider.id, executables[provider.id]?.trim() || undefined)))).flat()
      setAvailability(old => ({ ...old, ...Object.fromEntries(results.map(row => [row.agentId, row])) }))
    } catch (e) { setError(errorMessage(e)) } finally { setChecking(false) }
  }
  const start = () => run(async () => {
    const row = await onStart(agent, { cwd: cwd.trim() || "~", executable: executables[agent]?.trim() || undefined })
    setSelected(row.executionId); setSetup(false); setSidebar(false)
  })
  const send = () => {
    if (!current || !canSend) return
    const key = draftKey, text = draft.trim(), id = current.executionId
    void run(async () => {
      await sendAgentMessage(id, text)
      // Do not erase text typed while IPC was in flight.
      setDrafts(all => ({ ...all, [key]: all[key]?.trim() === text ? "" : all[key] }))
      setFollowing(true)
    })
  }
  const changeConfig = async (id: string, value: string | boolean) => {
    if (!current || configBusy) return
    setConfigBusy(true); setError(null)
    try { await setAgentConfig(current.executionId, id, value) } catch (e) { setError(errorMessage(e)) } finally { setConfigBusy(false) }
  }
  const approve = (option: AgentPermissionOption) => {
    if (!current?.pendingPermission) return
    const permission = current.pendingPermission
    void run(() => respondAgentPermission(current.executionId, permission.requestId, option.optionId))
  }
  const newThread = () => { setSelected(null); setSetup(false); setSidebar(false); prompt.current?.focus() }
  const commands = (current?.commands || []).filter(command => !draft.startsWith("/") || command.name.startsWith(draft.slice(1).split(" ")[0]))

  return <section ref={surface} tabIndex={-1} className="agent-workspace" role="dialog" aria-modal="true" aria-label={`Agents on ${session.name}`}
    onKeyDown={e => {
      e.stopPropagation()
      if (e.key === "Escape") { e.preventDefault(); if (setup) setSetup(false); else if (showCommands) setShowCommands(false); else onClose() }
      if (e.key === "Tab") {
        const controls = [...(surface.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary') || [])].filter(el => el.getClientRects().length)
        const first = controls[0], last = controls.at(-1)
        if (e.shiftKey && (document.activeElement === first || document.activeElement === surface.current)) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}>
    <header className="agent-topbar">
      <div className="agent-topbar-left"><button className="agent-icon-button agent-mobile-menu" aria-label="Toggle threads" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}>☰</button>
        <button className="agent-back" onClick={onClose}><span aria-hidden="true">←</span> Workspace</button><span className="agent-topbar-divider" />
        <span className="agent-topbar-title">Agents</span><span className="agent-host">{session.name}</span></div>
      <button className="agent-button" onClick={() => setSetup(!setup)} aria-expanded={setup}>Agent setup</button>
    </header>
    <div className="agent-body">
      <aside className={`agent-sidebar ${sidebar ? "is-open" : ""}`} aria-label="Agent threads">
        <button className="agent-new-thread" onClick={newThread}><span aria-hidden="true">+</span> New thread</button>
        <div className="agent-sidebar-heading">ON THIS SERVER <span>{threads.length}</span></div>
        <nav className="agent-thread-list">{threads.map(row => <button key={row.executionId} aria-current={row.executionId === selected ? "page" : undefined}
          className={`agent-thread ${row.executionId === selected ? "is-selected" : ""}`} onClick={() => { setSelected(row.executionId); setSetup(false); setSidebar(false) }}>
          <span className="agent-thread-title">{eventTitle(row)}</span><span className="agent-thread-meta">{row.agentName}<span className={`agent-state-dot ${row.pendingPermission ? "attention" : row.turnActive ? "active" : ""}`} />{status(row)}</span>
        </button>)}</nav>
        {!threads.length && <p className="agent-sidebar-empty">Your conversations will appear here.</p>}
        <div className="agent-sidebar-footer"><span className="agent-server-label">REMOTE EXECUTION</span><strong>{session.username}@{session.host}</strong>
          <p>Files and agent credentials stay on this server.</p><button className="agent-link-button" onClick={() => setSetup(true)}>Manage agents <span aria-hidden="true">↗</span></button></div>
      </aside>
      <main className="agent-main">
        {setup ? <div className="agent-setup scroll-quiet">
          <div className="agent-section-heading"><div><span className="agent-eyebrow">EXECUTION HOST · {session.host}</span><h1>Set up your agents.</h1><p>Install and sign in on the remote server. Still connects to that installation.</p></div>
            <button className="agent-button" onClick={() => void check()} disabled={checking}>{checking ? "Checking server…" : "Check installed agents"}</button></div>
          <div className="agent-provider-list">{AGENTS.map(provider => <button key={provider.id} className={`agent-provider ${agent === provider.id ? "is-selected" : ""}`} onClick={() => setAgent(provider.id)} aria-pressed={agent === provider.id}>
            <span className="agent-provider-name">{provider.label}<small>{provider.launchKind === "native" ? "Native ACP" : "ACP adapter"}</small></span>
            <span className={`agent-detection ${availability[provider.id]?.available ? "found" : ""}`}>{availability[provider.id] ? availability[provider.id].available ? "Executable found" : "Not found" : "Not checked"}</span></button>)}</div>
          <div className="agent-setup-detail"><h2>{definition.label}</h2><p>{definition.note}</p>
            <ol className="agent-setup-steps"><li><strong>Install in the server terminal</strong><code>{definition.installCommand}</code></li>
              <li><strong>Sign in on the server</strong><code>{definition.loginCommand}</code></li></ol>
            <p className="agent-small">Commands require a compatible Node.js/npm installation. Review before running; Still will not execute them automatically.</p>
            <label className="agent-field">Executable path <span>Optional · for a nonstandard installation</span>
              <input value={executables[agent] || ""} onChange={e => setExecutables(old => ({ ...old, [agent]: e.target.value }))} placeholder={`/absolute/path/to/${definition.executable}`} /></label>
            <div className="agent-setup-actions"><button className="agent-button" disabled={checking} onClick={() => void check(true)}>Check {definition.label}</button><button className="agent-link-button" onClick={onOpenTerminal}>Open server terminal →</button></div>
            {availability[agent]?.available && <p className="agent-small">Found: <code>{availability[agent].executable}</code>. This checks the executable only; login and ACP compatibility are verified when connecting.</p>}
          </div>
          <button className="agent-button" onClick={() => setSetup(false)}>Back to conversation</button>
          {error && <div className="agent-error" role="alert">{error}</div>}
        </div> : <>
          <header className="agent-thread-header"><div><h1>{current ? eventTitle(current) : "New conversation"}</h1><p title={current?.cwd || cwd}>{current?.cwd || cwd}</p></div>
            {current && <div className="agent-thread-actions"><span className="agent-status" role="status">{status(current)}</span><button className="agent-button" disabled={busy} onClick={() => void run(() => refreshAgentThread(current.executionId))}>Refresh</button></div>}</header>
          <div ref={log} className="agent-conversation scroll-quiet" onScroll={() => { const el = log.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }} aria-label="Conversation">
            {!current ? <div className="agent-welcome"><span className="agent-eyebrow">STILL / AGENTS</span><h2>A proper workspace<br />for your next idea.</h2><p>Choose an agent installed on <strong>{session.name}</strong>, connect to your project, and start a conversation.</p>
              <div className="agent-launch-fields"><label className="agent-field">Agent<select aria-label="Agent" value={agent} onChange={e => setAgent(e.target.value)}>{AGENTS.map(provider => <option key={provider.id} value={provider.id}>{provider.label}{availability[provider.id] ? availability[provider.id].available ? " · found" : " · not found" : ""}</option>)}</select></label>
                <label className="agent-field">Remote project directory<input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="~/projects/my-app" /></label></div>
              <p className="agent-small">{definition.note}</p><div className="agent-welcome-actions"><button className="agent-primary" disabled={busy || checking || availability[agent]?.available === false} onClick={() => void start()}>{busy ? "Starting agent…" : `Connect ${definition.label}`}</button><button className="agent-link-button" onClick={() => setSetup(true)}>Installation & sign-in →</button></div>
            </div> : <div className="agent-message-list">
              {!items.length && <div className="agent-thread-empty"><h2>{current.state === "connecting" ? "Connecting to your agent…" : `You're connected to ${current.agentName}.`}</h2><p>{current.state === "connecting" ? "Checking the remote ACP session and available settings." : "Tell it what you want to build, fix, or understand."}</p></div>}
              {items.map(item => item.kind === "tool" ? <details key={item.id} className="agent-tool"><summary><span className={`agent-state-dot ${item.status === "in_progress" ? "active" : ""}`} /><span>{item.title || "Tool call"}</span><small>{item.status?.replace(/_/g, " ") || "pending"}</small></summary>
                <div className="agent-tool-body">{item.text && <pre>{item.text}</pre>}{item.content && <AgentToolResult content={item.content} />}{!item.text && !item.content?.length && <p>No tool details were supplied by this agent.</p>}</div></details>
                : item.kind === "reasoning" ? <details key={item.id} className="agent-reasoning"><summary>Reasoning</summary><AgentMessage text={item.text} /></details>
                  : <article key={item.id} className={`agent-message agent-message-${item.kind}`}><div className="agent-message-author">{item.kind === "user" ? "You" : current.agentName}</div>{item.kind === "user" ? <p className="agent-user-text">{item.text}</p> : <AgentMessage text={item.text} />}</article>)}
              {plan?.length ? <details className="agent-plan" open><summary>Plan <small>{plan.filter(entry => entry.status === "completed").length}/{plan.length}</small></summary><ol>{plan.map((entry, i) => <li key={i} className={entry.status}><span aria-label={entry.status}>{entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "◉" : "○"}</span>{entry.content}</li>)}</ol></details> : null}
              {current.turnActive && !current.pendingPermission && <div className="agent-working" role="status"><span className="agent-state-dot active" />{current.lastError?.includes("Cancellation") ? "Waiting for stop confirmation…" : `${current.agentName} is working…`}</div>}
            </div>}
          </div>
          {!following && current && <button className="agent-jump" onClick={() => setFollowing(true)}>↓ Latest activity</button>}
          <div className="agent-composer-area">
            {current?.pendingPermission && <section className="agent-permission" aria-label="Pending approval"><div className="agent-permission-heading"><span className="agent-eyebrow">YOUR APPROVAL IS NEEDED</span><h2>{current.pendingPermission.title}</h2></div>
              {current.pendingPermission.description && <p>{current.pendingPermission.description}</p>}{current.pendingPermission.command && <pre>{current.pendingPermission.command}</pre>}
              <div className="agent-permission-actions">{current.pendingPermission.options.map(option => <button key={option.optionId} disabled={busy} className={option.kind === "allow_once" ? "agent-primary" : "agent-button"} onClick={() => approve(option)}>{option.name}</button>)}</div>
              <p className="agent-small">Choices and their scope come from the agent. An “always” choice may persist beyond this thread.</p></section>}
            {(error || current?.lastError && current.state !== "working") && <div className="agent-error" role="alert">{error || current?.lastError}<button className="agent-link-button" onClick={() => setSetup(true)}>Check agent setup →</button></div>}
            <form className={`agent-composer ${!current ? "is-inactive" : ""}`} onSubmit={e => { e.preventDefault(); send() }}>
              {(showCommands || draft.startsWith("/") && !draft.includes(" ")) && commands.length > 0 && <div className="agent-command-menu" aria-label="Agent commands">{commands.map(command => <button type="button" key={command.name} onClick={() => { setDraft(`/${command.name} `); setShowCommands(false); prompt.current?.focus() }}><strong>/{command.name}</strong><span>{command.description}</span></button>)}</div>}
              <textarea ref={prompt} aria-label="Message agent" value={draft} rows={2} placeholder={current ? current.pendingPermission ? "Resolve the approval to continue…" : "Ask your agent to build, fix, or explore…" : "Connect an agent to start chatting…"}
                disabled={!current} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
              <div className="agent-composer-toolbar"><div className="agent-composer-controls"><span className="agent-composer-provider">{current?.agentName || definition.label}</span>
                {current?.configOptions.map(option => <ConfigControl key={option.id} option={option} disabled={!idle(current) || busy || configBusy} change={(id, value) => void changeConfig(id, value)} />)}
                {!!current?.commands?.length && <button type="button" className="agent-button" aria-expanded={showCommands} onClick={() => setShowCommands(!showCommands)}>Commands</button>}
                {configBusy && <span className="agent-small" role="status">Applying setting…</span>}</div>
                {current?.turnActive ? <button type="button" className="agent-stop" disabled={busy} onClick={() => void run(() => cancelAgentTurn(current.executionId))}>■ Stop</button>
                  : <button className="agent-send" disabled={!canSend} type="submit">Send <span aria-hidden="true">↑</span></button>}</div>
            </form>
            <div className="agent-composer-footnote"><span>{current && !current.configOptions.some(option => option.category === "model") ? "Model selection isn't advertised by this agent." : "Enter to send · Shift+Enter for a new line"}</span><span>Remote foreground · not supervised</span></div>
          </div>
        </>}
      </main>
    </div>
  </section>
}
