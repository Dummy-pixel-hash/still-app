/* THESIS: A project-first phone index, not one undifferentiated chat feed.
 * OWN-WORLD: Preserve Still's approved black/rose phone identity and native pickers.
 * STORY: Choose a project, scan its newest conversations, then act on Needs you.
 * FIRST VIEWPORT: Existing header, project/order controls, filters and flat project
 * sections; one New task action and the incumbent floating navigation.
 * FORM: An Operate-mode extension of the approved mobile shell, not a redesign. */
import { useCallback, useEffect, useRef, useState } from "react"
import RemoteAgentWorkspace from "../components/RemoteAgentWorkspace"
import AuthDialog from "../components/AuthDialog"
import { StillAgentMark } from "../components/AgentProviderMark"
import { agentConnectionId, agentServerProfile, folderName, hostKey, hostLabel, projectKey, readLibraryPreferences, sessionForHost, sharedProjectDeleted, sharedProjects, type AgentProject } from "../agents/workspace"
import { loadAgentThreads, stopRemoteAgentLibrary, useAgentThreads, watchRemoteAgentLibrary, type AgentLibrarySyncStatus, type AgentThreadRow } from "../session/agentThreads"
import AgentLibrarySyncNotice from "../components/AgentLibrarySyncNotice"
import { disconnectSession, nativeSessionId } from "../session/connections"
import { useAgentConnection, AgentConnectionNotice } from "../components/AgentConnection"
import { saveAgentWorkspace, storedWorkspace, useAgentStorage } from "../session/agentStorage"
import { createProject, createSession, setDefaultTheme, updateTerminalPrefs, useStore } from "../session/store"
import { PRESET_THEMES } from "../terminal/appearance"
import { nativeBridge } from "../bridge/nativeBridge"
import type { AskSessionAuth } from "../session/connectRequest"
import type { Session } from "../types"
import MobileIcon from "./MobileIcon"
import { UpdateSettings } from "../updates/UpdateNotice"
import MobileTerminal from "./MobileTerminal"
import { visibleThreads } from "./threads"
import { MOBILE_LIBRARY_KEY, mobileLibraryPreferences, mobileProjectLibrary, type MobileLibraryPreferences } from "./projectThreads"
import { MobileProjectControls, MobileProjectThreads } from "./MobileProjectThreads"
import "./mobile.css"

type Destination = "agents" | "terminals" | "settings"
type AgentEntry = { kind: "agent"; mode: "conversation" | "new" | "project" | "settings"; id?: string; session: Session | null; project?: AgentProject }
type Entry = AgentEntry | { kind: "terminal"; session: Session } | { kind: "terminal-new" } | { kind: "server-new"; editing?: Session } | null
type AuthAnswer = { secret?: string; remember: boolean } | null
const syncSourceLabel = (server: Session) => `Sync conversations · ${server.name || server.host} · ${hostLabel(hostKey(server))}`
declare global { interface Window { __stillMobileBack?: () => boolean } }

export default function MobileApp() {
  const store = useStore(), storage = useAgentStorage(), allThreads = useAgentThreads()
  const [destination, setDestination] = useState<Destination>("agents"), [entry, setEntry] = useState<Entry>(null)
  const [ready, setReady] = useState(false), [error, setError] = useState("")
  const [agentServers, setAgentServers] = useState<Session[]>(() => readLibraryPreferences().servers)
  const [serverError, setServerError] = useState("")
  const [serverMenu, setServerMenu] = useState<Session | null>(null), [serverToRemove, setServerToRemove] = useState<Session | null>(null)
  const [filter, setFilter] = useState<"recent" | "attention">("recent")
  const [viewPreferences, setViewPreferences] = useState(() => mobileLibraryPreferences(storedWorkspace(MOBILE_LIBRARY_KEY)))
  const preferencesRef = useRef(viewPreferences), preferencesLoaded = useRef(false)
  preferencesRef.current = viewPreferences
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(""), [projectsOpen, setProjectsOpen] = useState(false)
  const [auth, setAuth] = useState<{ session: Session; resolve: (answer: AuthAnswer) => void } | null>(null)
  const [syncServer, setSyncServer] = useState<Session | null>(null)
  const [syncAccountsOpen, setSyncAccountsOpen] = useState(false)
  const [terminalServer, setTerminalServer] = useState(""), [terminalName, setTerminalName] = useState(""), [terminalFolder, setTerminalFolder] = useState("~")
  const authRef = useRef<typeof auth>(null); authRef.current = auth
  const searchRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLDivElement>(null), listPosition = useRef(0)
  const library = readLibraryPreferences()
  const threads = visibleThreads(allThreads)
  const projects = [...new Map<string, AgentProject>([...threads.map((row): AgentProject => ({ host: row.meta.hostKey, folder: row.meta.folder })), ...library.projects, ...sharedProjects()].map(project => [projectKey(project), project])).values()].filter(project => !sharedProjectDeleted(project))
  const servers = [...new Map([...agentServers, ...store.sessions.filter(session => session.transport !== "local"), ...projects.map(project => sessionForHost(project.host, agentServers)).filter((session): session is Session => !!session)].map(session => [hostKey(session), session])).values()]
  const projectFilter = viewPreferences.project
  const projectView = mobileProjectLibrary(threads, projects, servers, { project: projectFilter, sort: viewPreferences.sort, attentionOnly: filter === "attention", query })
  const updateView = (patch: Partial<MobileLibraryPreferences>) => {
    const next = mobileLibraryPreferences({ ...preferencesRef.current, ...patch })
    preferencesRef.current = next; setViewPreferences(next)
    saveAgentWorkspace(MOBILE_LIBRARY_KEY, next)
  }
  const setProjectFilter = (project: string) => { listPosition.current = 0; if (listRef.current) listRef.current.scrollTop = 0; setSyncAccountsOpen(false); updateView({ project }) }
  const selectSort = (sort: MobileLibraryPreferences["sort"]) => { listPosition.current = 0; if (listRef.current) listRef.current.scrollTop = 0; updateView({ sort }) }
  const toggleProject = (key: string) => updateView({ collapsed: viewPreferences.collapsed.includes(key) ? viewPreferences.collapsed.filter(value => value !== key) : [...viewPreferences.collapsed, key] })
  useEffect(() => {
    if (ready && preferencesLoaded.current && projectFilter !== "all" && !projectView.activeProject) {
      const next = { ...preferencesRef.current, project: "all" }
      preferencesRef.current = next; setViewPreferences(next); saveAgentWorkspace(MOBILE_LIBRARY_KEY, next)
    }
  }, [ready, projectFilter, projectView.activeProject])

  const hydrate = useCallback(async () => {
    try {
      await loadAgentThreads(); setAgentServers(readLibraryPreferences().servers)
      if (!preferencesLoaded.current) {
        const saved = mobileLibraryPreferences(storedWorkspace(MOBILE_LIBRARY_KEY))
        preferencesRef.current = saved; setViewPreferences(saved); preferencesLoaded.current = true
      }
      setReady(true); setError("")
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not open your saved threads.") }
  }, [])
  useEffect(() => { document.documentElement.classList.add("still-mobile"); void hydrate(); return () => { document.documentElement.classList.remove("still-mobile"); authRef.current?.resolve(null) } }, [hydrate])
  useEffect(() => { if (!entry && listRef.current) listRef.current.scrollTop = listPosition.current }, [entry, destination])
  const closeEntry = () => { if (authRef.current) { authRef.current.resolve(null); setAuth(null) } setEntry(null) }
  useEffect(() => {
    const back = () => {
      if (authRef.current) { authRef.current.resolve(null); setAuth(null); return true }
      if (serverToRemove) { setServerToRemove(null); return true }
      if (serverMenu) { setServerMenu(null); return true }
      if (projectsOpen) { setProjectsOpen(false); return true }
      if (entry?.kind === "agent") {
        const workspace = document.querySelector<HTMLElement>(".agent-workspace--mobile")
        if (workspace) workspace.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
        else setEntry(null)
        return true
      }
      if (entry) { closeEntry(); return true }
      if (syncAccountsOpen) { setSyncAccountsOpen(false); return true }
      if (searchOpen) { setSearchOpen(false); setQuery(""); return true }
      if (destination !== "agents") { setDestination("agents"); return true }
      return false
    }
    window.__stillMobileBack = back
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || event.target instanceof HTMLTextAreaElement) return
      if (back()) event.preventDefault()
    }
    window.addEventListener("keydown", keyboard)
    return () => { delete window.__stillMobileBack; window.removeEventListener("keydown", keyboard) }
  }, [entry, projectsOpen, searchOpen, destination, serverMenu, serverToRemove, syncAccountsOpen])
  const askAuth: AskSessionAuth = useCallback(async session => {
    if (session.authMethod === "key" && session.keyId && await nativeBridge.hasKeySecret(session.keyId).catch(() => false)) return { remember: true }
    if (await nativeBridge.hasCredential(session.host, session.port, session.username).catch(() => false)) return { remember: true }
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
  const saveServer = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setServerError("")
    const data = new FormData(event.currentTarget)
    const hostName = String(data.get("host") || "").trim(), username = String(data.get("username") || "").trim()
    const port = Number(String(data.get("port") || "22").trim()), name = String(data.get("name") || "").trim()
    const authMethod = String(data.get("authMethod") || "ask") as Session["authMethod"]
    if (!hostName || /[\s\u0000-\u001f]/.test(hostName)) { setServerError("Enter a host name or IP address without spaces."); return }
    if (!username || /[\s\u0000-\u001f]/.test(username)) { setServerError("Enter the SSH username for this account."); return }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setServerError("Port must be between 1 and 65535."); return }
    const now = Date.now()
    const editing = entry?.kind === "server-new" ? entry.editing : undefined
    const profile: Session = { id: editing?.id || `agent-server:${JSON.stringify([hostName.toLowerCase(), port, username])}`, name: name || hostName, host: hostName, port, username, projectId: "", workingDirectory: "", authMethod, remember: false, tmuxSession: "", createdAt: editing?.createdAt || now, updatedAt: now }
    const identity = hostKey(profile)
    if (agentServers.some(server => hostKey(server) === identity && (!editing || hostKey(server) !== hostKey(editing)))) { setServerError("This server and account are already saved."); return }
    const next = [...agentServers.filter(server => !editing || hostKey(server) !== hostKey(editing)).map(agentServerProfile), agentServerProfile(profile)]
    saveAgentWorkspace("library", { ...readLibraryPreferences(), servers: next })
    setAgentServers(next)
    setServerError(editing && hostKey(editing) !== identity ? "Saved. Credentials for the previous address stay in secure storage and will not be used for this new address." : "")
    setEntry(null); setProjectsOpen(true); setDestination("agents")
  }
  const removeServer = async (server: Session) => {
    const identity = hostKey(server)
    const sharedWithTerminal = store.sessions.some(session => session.transport !== "local" && hostKey(session) === identity)
    const next = agentServers.filter(profile => hostKey(profile) !== identity).map(agentServerProfile)
    const localId = agentConnectionId(server), nativeId = nativeSessionId(localId)
    if (nativeId) stopRemoteAgentLibrary(nativeId)
    await disconnectSession(localId, { silent: true }).catch(() => setServerError("The saved server was removed, but its old connection could not be confirmed closed."))
    if (syncServer && hostKey(syncServer) === identity) setSyncServer(null)
    saveAgentWorkspace("library", { ...readLibraryPreferences(), servers: next })
    await nativeBridge.agentFlush().catch(() => {})
    setAgentServers(next); setServerToRemove(null); setProjectsOpen(true)
    if (!sharedWithTerminal) {
      const results = await Promise.allSettled([nativeBridge.forgetCredential(server.host, server.port, server.username), nativeBridge.forgetHost(server.host, server.port)])
      if (results.some(result => result.status === "rejected")) setServerError("Server removed; some remembered credentials or host trust could not be cleared. Review this device’s secure storage.")
    }
  }
  const projectName = projectView.projects.find(project => project.key === projectFilter)?.label || "this project"
  const resultProjects = projectView.groups.length || (projectView.activeProject ? 1 : 0)
  const canCollapse = projectFilter === "all" && filter === "recent" && !query.trim()
  const syncServers = projectView.activeProject ? servers.filter(server => hostKey(server) === projectView.activeProject!.host) : servers
  const inactiveProject = !!projectView.activeProject && sharedProjectDeleted(projectView.activeProject)

  return <div className="mobile-app" data-mobile-shell="true" data-detail={entry ? "true" : undefined}>
    <div className="mobile-root-content" inert={!!entry || projectsOpen || !!auth}>
    <div className="mobile-page-panel" key={`${destination}:${entry ? "covered" : "root"}`}>
    <header className="mobile-app-bar"><div className="mobile-wordmark"><StillAgentMark size={38} /><span>Still</span></div><div className="mobile-app-actions">{destination === "agents" && <button className="mobile-icon-button" aria-label="Search threads" onClick={() => { setSearchOpen(open => !open); if (searchOpen) setQuery(""); else setTimeout(() => searchRef.current?.focus(), 0) }}><MobileIcon name="search" /></button>}<button className="mobile-icon-button" aria-label="Manage projects and servers" onClick={() => setProjectsOpen(true)}><MobileIcon name="folder" size={20} /></button></div></header>
    {destination === "agents" && <>
      <div className="mobile-heading"><h1>Threads</h1></div>
      {searchOpen && <div className="mobile-search" role="search"><MobileIcon name="search" size={18} /><input aria-label="Find a thread" ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a thread…" type="search" enterKeyHint="search" /><button className="mobile-icon-button" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery("") }}><MobileIcon name="close" size={17} /></button></div>}
      <nav className="mobile-thread-filters" aria-label="Filter threads"><button aria-pressed={filter === "recent"} onClick={() => setFilter("recent")}>All threads</button><button aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>Needs you{projectView.attention > 0 && <span>{projectView.attention}</span>}</button></nav>
      <div className="mobile-scroll mobile-thread-list" ref={listRef} onScroll={event => { listPosition.current = event.currentTarget.scrollTop }}>
        <MobileProjectControls projects={projectView.projects} selected={projectFilter} sort={viewPreferences.sort} disabled={!ready} onProject={setProjectFilter} onSort={selectSort} />
        {(error || storage.error) && <div className="mobile-error" role="alert"><p>{error || storage.error}</p><button className="mobile-text-button" onClick={() => void hydrate()}>Try again</button></div>}
        {(projectView.resultCount > 0 || syncServers.length > 0) && <div className="mobile-library-meta">
          <p className="mobile-library-summary" role="status">{ready && `${projectView.resultCount} ${projectView.resultCount === 1 ? "thread" : "threads"}${resultProjects ? ` in ${resultProjects} ${resultProjects === 1 ? "project" : "projects"}` : ""}${query.trim() ? " matching your search" : ""}`}</p>
          {syncServers.length > 0 && <button className="mobile-library-sync-trigger" disabled={!ready} aria-label={syncServers.length === 1 ? syncSourceLabel(syncServers[0]) : "Choose a server to sync conversations"} aria-expanded={syncServers.length > 1 ? syncAccountsOpen : undefined} aria-controls={syncServers.length > 1 ? "mobile-sync-sources" : undefined} onClick={() => syncServers.length === 1 ? setSyncServer(syncServers[0]) : setSyncAccountsOpen(open => !open)}><MobileIcon name="sync" size={15} />Sync{syncServers.length > 1 && <MobileIcon name="chevron" size={12} />}</button>}
        </div>}
        {syncServers.length > 1 && syncAccountsOpen && <div id="mobile-sync-sources" className="mobile-sync-accounts" aria-label="Remote conversation sync">{syncServers.map(server => <button key={hostKey(server)} className="mobile-text-button" aria-label={syncSourceLabel(server)} onClick={() => { setSyncServer(server); setSyncAccountsOpen(false) }}><span className="mobile-sync-source-label"><span>Sync conversations · {server.name || server.host}</span><small>{hostLabel(hostKey(server))}</small></span></button>)}</div>}
        {syncServer && (!projectView.activeProject || projectView.activeProject.host === hostKey(syncServer)) && <MobileLibrarySync session={syncServer} askAuth={askAuth} onClose={() => setSyncServer(null)} />}
        {!ready && !error ? <p className="mobile-loading" role="status">Opening your threads…</p> : projectView.resultCount ? <>
          {projectView.groups.map(group => <MobileProjectThreads key={group.key} group={group} collapsible={canCollapse} collapsed={canCollapse && viewPreferences.collapsed.includes(group.key)} attentionById={projectView.attentionById} onToggle={() => toggleProject(group.key)} onOpen={row => openAgent("conversation", row)} />)}
        </> : <div className="mobile-empty">
          <MobileIcon name={query.trim() ? "search" : filter === "attention" ? "check" : "folder"} size={31} />
          <h2>{query.trim() ? "No matching threads" : filter === "attention" ? projectFilter === "all" ? "You’re all caught up." : "No requests in this project." : projectFilter !== "all" ? "No threads in this project yet." : "A place for your next idea."}</h2>
          <p>{query.trim() ? "Try another thread title, project, server or agent." : filter === "attention" ? projectFilter !== "all" && projectView.totalAttention > 0 ? "Other projects have conversations that need you." : "Questions and approvals will appear here." : projectFilter !== "all" ? `Start a task in ${projectName}, or choose another project.` : "Connect a remote project to start your first conversation."}</p>
          {projectFilter !== "all" && <button className="mobile-text-button" onClick={() => setProjectFilter("all")}>Show all projects</button>}
          {!query.trim() && filter === "recent" && projectFilter === "all" && <button className="mobile-text-button" onClick={() => openAgent("project")}>Add a project <MobileIcon name="arrow-right" size={16} /></button>}
        </div>}
      </div>
      <footer className="mobile-new-row"><button className="mobile-new-task" disabled={!ready || inactiveProject} title={inactiveProject ? "Choose an active project before starting a task" : projectView.activeProject ? `New task in ${projectName}` : "New task"} onClick={() => openAgent("new", undefined, projectView.activeProject || undefined)}><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v8m-4-4h8" /></svg>New task</button></footer>
    </>}
     {destination === "terminals" && <><div className="mobile-heading"><h1>Terminals</h1></div><div className="mobile-scroll mobile-session-list">{store.sessions.filter(session => session.transport !== "local").length ? store.sessions.filter(session => session.transport !== "local").map(session => <button key={session.id} className="mobile-session-row" onClick={() => setEntry({ kind: "terminal", session })}><MobileIcon name="terminal" /><span><strong>{session.name}</strong><small>{session.username}@{session.host}</small><small className="mobile-mono">{session.workingDirectory}</small></span><MobileIcon name="chevron" size={15} /></button>) : <div className="mobile-empty"><MobileIcon name="terminal" size={32} /><h2>Your shell, wherever.</h2><p>Open a persistent remote session. Leaving the screen keeps your server work running.</p></div>}</div><footer className="mobile-new-row"><button className="mobile-new-task" onClick={() => setEntry({ kind: "terminal-new" })}><MobileIcon name="plus" size={17} />New session</button></footer></>}
      {destination === "settings" && <><div className="mobile-heading"><h1>Settings</h1></div><div className="mobile-scroll mobile-settings"><h2>Workspace</h2><button className="mobile-settings-row" onClick={() => setProjectsOpen(true)}><MobileIcon name="server" /><span><strong>Servers and projects</strong><small>{servers.length ? `${servers.length} saved ${servers.length === 1 ? "server" : "servers"}` : "Add a remote server"}</small></span><MobileIcon name="chevron" size={15} /></button><button className="mobile-settings-row" onClick={() => { setProjectsOpen(false); setServerError(""); setEntry({ kind: "server-new" }) }}><MobileIcon name="plus" /><span><strong>Add a server</strong><small>SSH host, username and port</small></span><MobileIcon name="chevron" size={15} /></button><button className="mobile-settings-row" onClick={() => openAgent("settings")}><MobileIcon name="settings" /><span><strong>Agent settings</strong><small>Installed providers and model connections</small></span><MobileIcon name="chevron" size={15} /></button><h2>Terminal</h2><label className="mobile-settings-row"><MobileIcon name="keyboard" /><span><strong>Text size</strong><small>{store.settings.terminal.fontSize}px</small></span><select aria-label="Terminal text size" value={store.settings.terminal.fontSize} onChange={event => updateTerminalPrefs({ fontSize: Number(event.target.value) })}>{[12, 14, 16, 18, 20].map(size => <option key={size} value={size}>{size}px</option>)}</select></label><label className="mobile-settings-row"><MobileIcon name="settings" /><span><strong>Terminal theme</strong><small>Default colours for every terminal</small></span><select aria-label="Terminal theme" value={store.settings.terminal.themeId} onChange={event => setDefaultTheme(event.target.value)}>{[...PRESET_THEMES, ...store.settings.customThemes].map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select></label>
        <UpdateSettings />
        <h2>On this device</h2><div className="mobile-setting-note"><strong>Private credentials</strong><p>Passwords and private keys stay in Android’s secure credential store, not in your thread library.</p></div><div className="mobile-setting-note"><strong>Phone features in progress</strong><p>Desktop-library sync and background notifications are not available in this development build yet.</p></div><p className="mobile-version">Still · Android development build</p></div></>}
    </div>
    <nav className="mobile-navigation" aria-label="Main navigation">{([["agents", "Agents"], ["terminals", "Terminals"], ["settings", "Settings"]] as const).map(([id, label]) => <button key={id} className={destination === id ? "is-active" : ""} aria-current={destination === id ? "page" : undefined} aria-label={label} onClick={() => selectDestination(id)}><MobileIcon name={id === "terminals" ? "terminal" : id} /><span>{label}</span>{id === "agents" && projectView.totalAttention > 0 && <i aria-hidden="true" />}</button>)}</nav>
    </div>

    {entry?.kind === "agent" && <RemoteAgentWorkspace key={`${entry.mode}:${entry.id || "new"}`} closing={false} session={entry.session} sessions={servers} onNeedAuth={askAuth} keyTextFor={() => null} onClose={closeEntry} onOpenTerminal={session => setEntry({ kind: "terminal", session })} presentation="mobile" initialConversationId={entry.id} initialView={entry.mode === "settings" ? "settings" : "draft"} initialProject={entry.project} initialProjectPicker={entry.mode === "project"} />}
    {entry?.kind === "terminal" && <MobileTerminal session={entry.session} settings={store.settings} askAuth={askAuth} onBack={closeEntry} />}
    {entry?.kind === "terminal-new" && <section className="mobile-terminal mobile-form-page"><header className="mobile-detail-bar"><button className="mobile-icon-button" onClick={closeEntry} aria-label="Back to terminals"><MobileIcon name="back" /></button><div><h1>New remote session</h1></div></header><form className="mobile-scroll mobile-form" onSubmit={createTerminal}><label>Session name<input required value={terminalName} onChange={event => setTerminalName(event.target.value)} placeholder="Project shell" /></label><label>Server<select required value={terminalServer} onChange={event => setTerminalServer(event.target.value)}><option value="">Choose a server</option>{servers.map(server => <option key={hostKey(server)} value={hostKey(server)}>{hostLabel(hostKey(server))}</option>)}</select></label>{!servers.length && <p>Add a server through Agents → Add a project first. No session or server is selected for you.</p>}<label>Remote folder<input value={terminalFolder} onChange={event => setTerminalFolder(event.target.value)} placeholder="~/projects/my-app" spellCheck={false} autoCapitalize="none" /></label><button className="mobile-primary" disabled={!terminalServer || !terminalName.trim()}>Create session</button></form></section>}
    {entry?.kind === "server-new" && <section className="mobile-terminal mobile-form-page"><header className="mobile-detail-bar"><button className="mobile-icon-button" onClick={closeEntry} aria-label="Back to settings"><MobileIcon name="back" /></button><div><h1>{entry.editing ? "Edit server" : "Add a remote server"}</h1><p>Credentials are requested securely only when you connect.</p></div></header><form className="mobile-scroll mobile-form" onSubmit={saveServer}><label>Server address<input name="host" required defaultValue={entry.editing?.host || ""} autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" placeholder="dev.example.com or 192.0.2.10" /></label><div className="mobile-server-fields"><label>SSH port<input name="port" type="number" inputMode="numeric" min="1" max="65535" defaultValue={entry.editing?.port || 22} required /></label><label>Username<input name="username" required defaultValue={entry.editing?.username || ""} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="alex" /></label></div><label>Display name <span className="mobile-optional">Optional</span><input name="name" defaultValue={entry.editing?.name || ""} autoCapitalize="words" placeholder="Work server" /></label><label>Authentication<select name="authMethod" defaultValue={entry.editing?.authMethod || "ask"}><option value="ask">Ask when connecting</option><option value="password">Password</option><option value="key">SSH private key</option></select></label><p className="mobile-form-hint">Still verifies the server fingerprint before sending credentials. Secrets are saved only in Android secure storage if you choose Remember.</p>{serverError && <p className="mobile-error" role="alert">{serverError}</p>}<button className="mobile-primary">{entry.editing ? "Save changes" : "Save server"}</button></form></section>}
    {projectsOpen && <div className="mobile-sheet-scrim" onClick={() => setProjectsOpen(false)}><section className="mobile-sheet" role="dialog" aria-modal="true" aria-label="Projects and servers" onClick={event => event.stopPropagation()}><header><h2>Projects and servers</h2><button className="mobile-icon-button" aria-label="Close projects" onClick={() => setProjectsOpen(false)}><MobileIcon name="close" size={18} /></button></header>{serverError && <p className="mobile-error" role="status">{serverError}</p>}<button className="mobile-project-row" onClick={() => { setProjectFilter("all"); setProjectsOpen(false); setDestination("agents") }}><MobileIcon name="agents" size={18} /><span>All projects</span>{projectFilter === "all" && <MobileIcon name="check" size={16} />}</button>{projects.map(project => <button className="mobile-project-row" key={projectKey(project)} onClick={() => { setProjectFilter(projectKey(project)); setProjectsOpen(false); setDestination("agents") }}><MobileIcon name="folder" size={18} /><span>{project.name || folderName(project.folder)}<small>{hostLabel(project.host)}</small></span>{projectFilter === projectKey(project) && <MobileIcon name="check" size={16} />}</button>)}<h3 className="mobile-sheet-section">Saved servers</h3>{servers.map(server => { const editable = agentServers.some(profile => hostKey(profile) === hostKey(server)); return <div className="mobile-server-row" key={hostKey(server)}><button className="mobile-project-row" onClick={() => { setProjectsOpen(false); openAgent("project", undefined, { host: hostKey(server), folder: "" }) }}><MobileIcon name="server" size={18} /><span>{server.name || server.host}<small>{server.username}@{server.host}:{server.port} · Add project</small></span><MobileIcon name="chevron" size={15} /></button>{editable && <button className="mobile-icon-button mobile-server-actions" aria-label={`Actions for ${server.name || server.host}`} onClick={() => { setProjectsOpen(false); setServerMenu(server) }}><MobileIcon name="more" size={18} /></button>}</div> })}<button className="mobile-project-row" onClick={() => { setProjectsOpen(false); setServerError(""); setEntry({ kind: "server-new" }) }}><MobileIcon name="plus" size={18} /><span>Add a server<small>Connect a new SSH host</small></span></button><button className="mobile-project-row" onClick={() => { setProjectsOpen(false); openAgent("project") }}><MobileIcon name="folder" size={18} /><span>Add a remote project<small>Choose a server and folder</small></span></button></section></div>}
    {serverMenu && <div className="mobile-sheet-scrim" onClick={() => setServerMenu(null)}><section className="mobile-sheet" role="dialog" aria-modal="true" aria-label={`Actions for ${serverMenu.name || serverMenu.host}`} onClick={event => event.stopPropagation()}><header><h2>{serverMenu.name || serverMenu.host}</h2><button className="mobile-icon-button" aria-label="Close server actions" onClick={() => setServerMenu(null)}><MobileIcon name="close" size={18} /></button></header><p className="mobile-form-hint">{serverMenu.username}@{serverMenu.host}:{serverMenu.port}</p><button className="mobile-project-row" onClick={() => { const server = serverMenu; setServerMenu(null); setServerError(""); setEntry({ kind: "server-new", editing: server }) }}><MobileIcon name="settings" size={18} /><span>Edit server details</span></button><button className="mobile-project-row mobile-server-remove" onClick={() => { setServerToRemove(serverMenu); setServerMenu(null) }}><MobileIcon name="close" size={18} /><span>Remove server</span></button></section></div>}
    {serverToRemove && <div className="mobile-sheet-scrim" onClick={() => setServerToRemove(null)}><section className="mobile-sheet" role="alertdialog" aria-modal="true" aria-label={`Remove ${serverToRemove.name || serverToRemove.host}`} onClick={event => event.stopPropagation()}><header><h2>Remove server?</h2><button className="mobile-icon-button" aria-label="Cancel remove server" onClick={() => setServerToRemove(null)}><MobileIcon name="close" size={18} /></button></header><p>Remove <strong>{serverToRemove.name || serverToRemove.host}</strong> from this device? Saved conversations stay here, but reconnecting will require adding and verifying the server again.</p><p className="mobile-form-hint">{store.sessions.some(session => session.transport !== "local" && hostKey(session) === hostKey(serverToRemove)) ? "Saved terminal sessions also use this server, so remembered credentials will be retained." : "When this server is not shared with a terminal, its remembered credentials and host trust will also be cleared from this device."}</p><button className="mobile-danger" onClick={() => void removeServer(serverToRemove)}>Remove server</button><button className="mobile-text-button" onClick={() => setServerToRemove(null)}>Keep server</button></section></div>}
    {auth && <AuthDialog session={auth.session} mode={auth.session.authMethod === "key" ? "key" : "password"} purpose={entry?.kind === "terminal" ? "terminal" : "agent"} onResolve={answer => { auth.resolve(answer); setAuth(null) }} />}
  </div>
}

function MobileLibrarySync({ session, askAuth, onClose }: { session: Session; askAuth: AskSessionAuth; onClose: () => void }) {
  const connection = useAgentConnection(session, askAuth, () => null)
  const [status, setStatus] = useState<AgentLibrarySyncStatus>({ message: "Connecting to read this server’s conversations…", failed: false, warnings: [], legacyRecords: [] })
  useEffect(() => {
    if (connection.state !== "connected" || !connection.nativeId) return
    return watchRemoteAgentLibrary(connection.nativeId, setStatus)
  }, [connection.state, connection.nativeId])
  return <section className="mobile-sync-status" aria-label={`Conversation sync for ${session.name}`}>
    <AgentConnectionNotice connection={connection} />
    <AgentLibrarySyncNotice status={status} />
    <button className="mobile-text-button" onClick={onClose}>Hide sync status</button>
  </section>
}
