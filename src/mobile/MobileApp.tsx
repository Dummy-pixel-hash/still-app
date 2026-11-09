/* Android's phone-first entry: the approved Threads/library and floating island.
 * The shared agent engine is reused for conversation, requests and configuration;
 * the desktop terminal workspace is never mounted underneath this shell. */
import { useCallback, useEffect, useRef, useState } from "react"
import RemoteAgentWorkspace from "../components/RemoteAgentWorkspace"
import AuthDialog from "../components/AuthDialog"
import AgentProviderMark, { StillAgentMark } from "../components/AgentProviderMark"
import { folderName, hostKey, hostLabel, projectKey, readLibraryPreferences, sessionForHost, type AgentProject } from "../agents/workspace"
import { loadAgentThreads, threadTitle, useAgentThreads, type AgentThreadRow } from "../session/agentThreads"
import { useAgentStorage } from "../session/agentStorage"
import { createProject, createSession, updateTerminalPrefs, useStore } from "../session/store"
import { nativeBridge } from "../bridge/nativeBridge"
import type { AskSessionAuth } from "../session/connectRequest"
import type { Session } from "../types"
import MobileIcon from "./MobileIcon"
import MobileTerminal from "./MobileTerminal"
import { mobileThreadStatus, needsAttention, relativeTime, visibleThreads } from "./threads"
import "./mobile.css"

type Destination = "agents" | "terminals" | "settings"
type AgentEntry = { kind: "agent"; mode: "conversation" | "new" | "project" | "settings"; id?: string; session: Session | null; project?: AgentProject }
type Entry = AgentEntry | { kind: "terminal"; session: Session } | { kind: "terminal-new" } | null
type AuthAnswer = { secret?: string; remember: boolean } | null
declare global { interface Window { __stillMobileBack?: () => boolean } }

export default function MobileApp() {
  const store = useStore(), storage = useAgentStorage(), allThreads = useAgentThreads()
  const [destination, setDestination] = useState<Destination>("agents"), [entry, setEntry] = useState<Entry>(null)
  const [ready, setReady] = useState(false), [error, setError] = useState("")
  const [filter, setFilter] = useState<"recent" | "attention">("recent"), [projectFilter, setProjectFilter] = useState("all")
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(""), [projectsOpen, setProjectsOpen] = useState(false)
  const [auth, setAuth] = useState<{ session: Session; resolve: (answer: AuthAnswer) => void } | null>(null)
  const [terminalServer, setTerminalServer] = useState(""), [terminalName, setTerminalName] = useState(""), [terminalFolder, setTerminalFolder] = useState("~")
  const authRef = useRef<typeof auth>(null); authRef.current = auth
  const searchRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLDivElement>(null), listPosition = useRef(0)
  const library = readLibraryPreferences()
  const threads = visibleThreads(allThreads)
  const projects = [...new Map<string, AgentProject>([...library.projects, ...threads.map((row): AgentProject => ({ host: row.meta.hostKey, folder: row.meta.folder }))].map(project => [projectKey(project), project])).values()]
  const servers = [...new Map([...library.servers, ...store.sessions.filter(session => session.transport !== "local"), ...projects.map(project => sessionForHost(project.host, library.servers)).filter((session): session is Session => !!session)].map(session => [hostKey(session), session])).values()]
  const attention = threads.filter(needsAttention).length
  const filtered = threads.filter(row => (filter !== "attention" || needsAttention(row)) && (projectFilter === "all" || projectKey({ host: row.meta.hostKey, folder: row.meta.folder }) === projectFilter) && (!query || `${threadTitle(row)} ${row.meta.folder} ${row.agentName}`.toLowerCase().includes(query.toLowerCase())))

  const hydrate = useCallback(async () => {
    try { await loadAgentThreads(); setReady(true); setError("") }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not open your saved threads.") }
  }, [])
  useEffect(() => { document.documentElement.classList.add("still-mobile"); void hydrate(); return () => { document.documentElement.classList.remove("still-mobile"); authRef.current?.resolve(null) } }, [hydrate])
  useEffect(() => { if (!entry && listRef.current) listRef.current.scrollTop = listPosition.current }, [entry, destination])
  const closeEntry = () => { if (authRef.current) { authRef.current.resolve(null); setAuth(null) } setEntry(null) }
  useEffect(() => {
    const back = () => {
      if (authRef.current) { authRef.current.resolve(null); setAuth(null); return true }
      if (projectsOpen) { setProjectsOpen(false); return true }
      if (entry?.kind === "agent") {
        const workspace = document.querySelector<HTMLElement>(".agent-workspace--mobile")
        if (workspace) workspace.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
        else setEntry(null)
        return true
      }
      if (entry) { setEntry(null); return true }
      if (searchOpen) { setSearchOpen(false); setQuery(""); return true }
      if (destination !== "agents") { setDestination("agents"); return true }
      return false
    }
    window.__stillMobileBack = back
    const keyboard = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !event.target?.toString().includes("HTMLTextArea")) { if (back()) event.preventDefault() } }
    window.addEventListener("keydown", keyboard)
    return () => { delete window.__stillMobileBack; window.removeEventListener("keydown", keyboard) }
  }, [entry, projectsOpen, searchOpen, destination])
  const askAuth: AskSessionAuth = useCallback(async session => {
    if (session.authMethod === "key" && session.keyId && await nativeBridge.hasKeySecret(session.keyId).catch(() => false)) return { remember: true }
    if (session.authMethod !== "key" && await nativeBridge.hasCredential(session.host, session.port, session.username).catch(() => false)) return { remember: true }
    return new Promise<AuthAnswer>(resolve => {
      authRef.current?.resolve(null)
      setAuth({ session, resolve })
    })
  }, [])
  const openAgent = (mode: AgentEntry["mode"], row?: AgentThreadRow, project?: AgentProject) => {
    if (listRef.current) listPosition.current = listRef.current.scrollTop
    const targetHost = row?.meta.hostKey || project?.host
    setEntry({ kind: "agent", mode, id: row?.meta.id, project, session: targetHost ? sessionForHost(targetHost, servers) : null })
  }
  const selectDestination = (next: Destination) => { setDestination(next); setQuery(""); setSearchOpen(false); setProjectsOpen(false) }
  const createTerminal = (event: React.FormEvent) => {
    event.preventDefault()
    const server = servers.find(session => hostKey(session) === terminalServer)
    if (!server || !terminalName.trim()) return
    const project = store.projects[0] || createProject("Remote sessions")
    const session = createSession({ name: terminalName.trim(), host: server.host, port: String(server.port), username: server.username, projectId: project.id, workingDirectory: terminalFolder.trim() || "~", authMethod: server.authMethod, keyId: server.keyId || "", remember: server.remember })
    setEntry({ kind: "terminal", session }); setTerminalName("")
  }
  const projectName = projectFilter === "all" ? "All projects" : folderName(projects.find(project => projectKey(project) === projectFilter)?.folder || "Project")

  return <div className="mobile-app" data-mobile-shell="true" data-detail={entry ? "true" : undefined}>
    <div className="mobile-root-content" inert={!!entry || projectsOpen || !!auth}>
    <header className="mobile-app-bar"><div className="mobile-wordmark"><StillAgentMark size={38} /><span>Still</span></div><div className="mobile-app-actions">{destination === "agents" && <button className="mobile-icon-button" aria-label="Search threads" onClick={() => { setSearchOpen(open => !open); setTimeout(() => searchRef.current?.focus(), 0) }}><MobileIcon name="search" /></button>}<button className="mobile-icon-button" aria-label="Manage projects and servers" onClick={() => setProjectsOpen(true)}><MobileIcon name="folder" size={20} /></button></div></header>
    {destination === "agents" && <>
      <div className="mobile-heading"><h1>Threads</h1>{projectFilter !== "all" && <button className="mobile-project-chip" onClick={() => setProjectsOpen(true)}>{projectName}<MobileIcon name="chevron" size={12} /></button>}</div>
      {searchOpen && <label className="mobile-search"><MobileIcon name="search" size={18} /><span className="mobile-sr-only">Find a thread</span><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a thread…" type="search" enterKeyHint="search" /><button className="mobile-icon-button" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery("") }}><MobileIcon name="close" size={17} /></button></label>}
      <nav className="mobile-thread-filters" aria-label="Filter threads"><button aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>Needs you{attention > 0 && <span>{attention}</span>}</button><button aria-pressed={filter === "recent"} onClick={() => setFilter("recent")}>Recent</button></nav>
      <div className="mobile-scroll mobile-thread-list" ref={listRef} onScroll={event => { listPosition.current = event.currentTarget.scrollTop }}>
        {(error || storage.error) && <div className="mobile-error" role="alert"><p>{error || storage.error}</p><button className="mobile-text-button" onClick={() => void hydrate()}>Try again</button></div>}
        {!ready && !error ? <p className="mobile-loading" role="status">Opening your threads…</p> : filtered.length ? filtered.map(row => {
          const state = mobileThreadStatus(row), pending = needsAttention(row)
          return <button className={`mobile-thread-row ${pending ? "needs-attention" : ""}`} key={row.meta.id} aria-label={`${threadTitle(row)} · ${state}`} onClick={() => openAgent("conversation", row)}><span className="mobile-thread-provider"><AgentProviderMark id={row.agentId} size={21} /></span><span className="mobile-thread-copy"><strong>{threadTitle(row)}</strong><small>{row.meta.parentConversationId ? "Subagent · " : ""}{folderName(row.meta.folder)}</small></span><span className="mobile-thread-trailing"><time dateTime={new Date(row.meta.activityAt).toISOString()}>{relativeTime(row.meta.activityAt)}</time><span className={pending ? "mobile-thread-state is-attention" : "mobile-thread-state"}>{row.turnActive && !pending ? <span className="mobile-working-bars" aria-hidden="true"><i /><i /><i /></span> : null}{state === "Complete" ? <MobileIcon name="check" size={14} /> : state}</span></span></button>
        }) : <div className="mobile-empty"><MobileIcon name={query ? "search" : filter === "attention" ? "check" : "agents"} size={31} /><h2>{query ? "No matching threads" : filter === "attention" ? "You’re all caught up." : "A place for your next idea."}</h2><p>{query ? "Try a different name or project." : filter === "attention" ? "Questions and approvals will appear here." : "Connect a remote project to start your first conversation."}</p>{!query && filter === "recent" && <button className="mobile-text-button" onClick={() => openAgent("project")}>Add a project <MobileIcon name="arrow-right" size={16} /></button>}</div>}
      </div>
      <footer className="mobile-new-row"><button className="mobile-new-task" disabled={!ready} onClick={() => openAgent("new")}><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v8m-4-4h8" /></svg>New task</button></footer>
    </>}
    {destination === "terminals" && <><div className="mobile-heading"><h1>Terminals</h1></div><div className="mobile-scroll mobile-session-list">{store.sessions.filter(session => session.transport !== "local").length ? store.sessions.filter(session => session.transport !== "local").map(session => <button key={session.id} className="mobile-session-row" onClick={() => setEntry({ kind: "terminal", session })}><MobileIcon name="terminal" /><span><strong>{session.name}</strong><small>{session.username}@{session.host}</small><small className="mobile-mono">{session.workingDirectory}</small></span><MobileIcon name="chevron" size={15} /></button>) : <div className="mobile-empty"><MobileIcon name="terminal" size={32} /><h2>Your shell, wherever.</h2><p>Open a persistent remote session. Leaving the screen keeps your server work running.</p></div>}</div><footer className="mobile-new-row"><button className="mobile-new-task" onClick={() => setEntry({ kind: "terminal-new" })}><MobileIcon name="plus" size={17} />New session</button></footer></>}
    {destination === "settings" && <><div className="mobile-heading"><h1>Settings</h1></div><div className="mobile-scroll mobile-settings"><h2>Workspace</h2><button className="mobile-settings-row" onClick={() => setProjectsOpen(true)}><MobileIcon name="server" /><span><strong>Servers and projects</strong><small>{servers.length ? `${servers.length} saved ${servers.length === 1 ? "server" : "servers"}` : "Connect your remote workspace"}</small></span><MobileIcon name="chevron" size={15} /></button><button className="mobile-settings-row" onClick={() => openAgent("settings")}><MobileIcon name="settings" /><span><strong>Agent settings</strong><small>Installed providers and model connections</small></span><MobileIcon name="chevron" size={15} /></button><h2>Terminal</h2><label className="mobile-settings-row"><MobileIcon name="keyboard" /><span><strong>Text size</strong><small>{store.settings.terminal.fontSize}px</small></span><select aria-label="Terminal text size" value={store.settings.terminal.fontSize} onChange={event => updateTerminalPrefs({ fontSize: Number(event.target.value) })}>{[12, 14, 16, 18, 20].map(size => <option key={size} value={size}>{size}px</option>)}</select></label><h2>On this device</h2><div className="mobile-setting-note"><strong>Private credentials</strong><p>Passwords and private keys stay in Android’s secure credential store, not in your thread library.</p></div><div className="mobile-setting-note"><strong>Phone features in progress</strong><p>Desktop-library sync and background notifications are not available in this development build yet.</p></div><p className="mobile-version">Still · Android development build</p></div></>}
    <nav className="mobile-navigation" aria-label="Main navigation">{([["agents", "Agents"], ["terminals", "Terminals"], ["settings", "Settings"]] as const).map(([id, label]) => <button key={id} className={destination === id ? "is-active" : ""} aria-current={destination === id ? "page" : undefined} aria-label={label} onClick={() => selectDestination(id)}><MobileIcon name={id === "terminals" ? "terminal" : id} /><span>{label}</span>{id === "agents" && attention > 0 && <i aria-hidden="true" />}</button>)}</nav>
    </div>

    {entry?.kind === "agent" && <RemoteAgentWorkspace key={`${entry.mode}:${entry.id || "new"}`} closing={false} session={entry.session} sessions={servers} onNeedAuth={askAuth} keyTextFor={() => null} onClose={closeEntry} onOpenTerminal={session => setEntry({ kind: "terminal", session })} presentation="mobile" initialConversationId={entry.id} initialView={entry.mode === "settings" ? "settings" : "draft"} initialProject={entry.project} initialProjectPicker={entry.mode === "project"} />}
    {entry?.kind === "terminal" && <MobileTerminal session={entry.session} settings={store.settings} askAuth={askAuth} onBack={closeEntry} />}
    {entry?.kind === "terminal-new" && <section className="mobile-terminal mobile-form-page"><header className="mobile-detail-bar"><button className="mobile-icon-button" onClick={closeEntry} aria-label="Back to terminals"><MobileIcon name="back" /></button><div><h1>New remote session</h1></div></header><form className="mobile-scroll mobile-form" onSubmit={createTerminal}><label>Session name<input required value={terminalName} onChange={event => setTerminalName(event.target.value)} placeholder="Project shell" /></label><label>Server<select required value={terminalServer} onChange={event => setTerminalServer(event.target.value)}><option value="">Choose a server</option>{servers.map(server => <option key={hostKey(server)} value={hostKey(server)}>{hostLabel(hostKey(server))}</option>)}</select></label>{!servers.length && <p>Add a server through Agents → Add a project first. No session or server is selected for you.</p>}<label>Remote folder<input value={terminalFolder} onChange={event => setTerminalFolder(event.target.value)} placeholder="~/projects/my-app" spellCheck={false} autoCapitalize="none" /></label><button className="mobile-primary" disabled={!terminalServer || !terminalName.trim()}>Create session</button></form></section>}
    {projectsOpen && <div className="mobile-sheet-scrim" onClick={() => setProjectsOpen(false)}><section className="mobile-sheet" role="dialog" aria-modal="true" aria-label="Projects and servers" onClick={event => event.stopPropagation()}><header><h2>Your projects</h2><button className="mobile-icon-button" aria-label="Close projects" onClick={() => setProjectsOpen(false)}><MobileIcon name="close" size={18} /></button></header><button className="mobile-project-row" onClick={() => { setProjectFilter("all"); setProjectsOpen(false); setDestination("agents") }}><MobileIcon name="agents" size={18} /><span>All projects</span>{projectFilter === "all" && <MobileIcon name="check" size={16} />}</button>{projects.map(project => <button className="mobile-project-row" key={projectKey(project)} onClick={() => { setProjectFilter(projectKey(project)); setProjectsOpen(false); setDestination("agents") }}><MobileIcon name="folder" size={18} /><span>{project.name || folderName(project.folder)}<small>{hostLabel(project.host)}</small></span>{projectFilter === projectKey(project) && <MobileIcon name="check" size={16} />}</button>)}<button className="mobile-project-row" onClick={() => { setProjectsOpen(false); openAgent("project") }}><MobileIcon name="plus" size={18} /><span>Add a remote project</span></button></section></div>}
    {auth && <AuthDialog session={auth.session} mode={auth.session.authMethod === "key" ? "key" : "password"} purpose={entry?.kind === "terminal" ? "terminal" : "agent"} onResolve={answer => { auth.resolve(answer); setAuth(null) }} />}
  </div>
}
