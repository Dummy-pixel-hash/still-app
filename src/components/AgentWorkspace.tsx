/* THESIS: A project conversation workspace, with the user's work leading.
 * OWN-WORLD: T3-informed charcoal surfaces, compact Geist UI, quiet line icons.
 * STORY: Pick a folder, choose an installed agent, converse and inspect its work.
 * FIRST VIEWPORT: 250px project sidebar, 48px toolbar, readable log, one composer.
 * FORM: User-pinned pingdotgg/t3code operating surface; contextual secondary controls.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { AGENTS, type AgentAvailability, type AgentLaunchOptions } from "../agents/types"
import { conversation } from "../agents/transcript"
import { folderName, hostKey, normalizeFolder, readWorkspace, saveWorkspace } from "../agents/workspace"
import { canResumeAgentThread, cancelAgentTurn, claimAgentThreads, clearAgentDraft, deleteAgentThread, refreshAgentThread, respondAgentPermission, resumeAgentThread, sendAgentMessage, setAgentConfig, subscribeRemoteAgent, threadTitle, updateThreadMeta, useAgentThreads, useAgentSaveError, type AgentThreadRow } from "../session/agentThreads"
import { discoverAgents, useAgentDiscovery } from "../session/agentDiscovery"
import { nativeBridge } from "../bridge/nativeBridge"
import type { Session } from "../types"
import AgentIcon from "./AgentIcon"
import { CommandPicker, ConfigPicker } from "./AgentControls"
import { AgentTimeline, InputCard, PermissionCard } from "./AgentTimeline"
import "../styles/agent-workspace.css"

type Props = {
  session: Session
  relatedSessionIds?: string[]
  connected?: boolean
  connectionNotice?: React.ReactNode
  onClose: () => void
  onOpenTerminal?: () => void
  onStart: (agentId: string, options?: AgentLaunchOptions, onCreated?: (row: AgentThreadRow) => void) => Promise<AgentThreadRow>
  onCheck: (agentId?: string, executable?: string) => Promise<AgentAvailability[]>
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : error && typeof error === "object" && "message" in error ? String(error.message) : String(error || "Operation failed")
const idle = (row: AgentThreadRow | null) => !!row && !row.turnActive && !row.pendingPermission && !row.pendingInput && ["working", "complete", "cancelled"].includes(row.state)
const status = (row: AgentThreadRow) => row.pendingPermission || row.pendingInput ? "Needs you" : row.state === "connecting" ? "Connecting" : row.turnActive ? "Working" : row.state === "submissionUnknown" ? canResumeAgentThread(row) ? "Saved" : "Uncertain" : row.state === "error" ? canResumeAgentThread(row) ? "Saved" : "Failed" : "Ready"

export default function AgentWorkspace({ session, relatedSessionIds, connected = true, connectionNotice, onClose, onOpenTerminal = onClose, onStart, onCheck }: Props) {
  const host = hostKey(session)
  const allThreads = useAgentThreads()
  const [prefs, setPrefs] = useState(() => readWorkspace(host, session.workingDirectory))
  const [selected, setSelected] = useState<string | null>(prefs.selectedId || null)
  const [setup, setSetup] = useState(false), [mobileSidebar, setMobileSidebar] = useState(false)
  const [query, setQuery] = useState(""), [archived, setArchived] = useState(false)
  const [menu, setMenu] = useState<string | null>(null), [folderMenu, setFolderMenu] = useState(false)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [rename, setRename] = useState<{ id: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState<AgentThreadRow | null>(null)
  const [undo, setUndo] = useState<{ id: string; at?: number } | null>(null)
  const [busy, setBusy] = useState(false), [configBusy, setConfigBusy] = useState(false)
  const [error, setError] = useState<string | null>(null), [advanced, setAdvanced] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false), [commandQuery, setCommandQuery] = useState("")
  const [following, setFollowing] = useState(true)
  const surface = useRef<HTMLElement>(null), log = useRef<HTMLDivElement>(null), textarea = useRef<HTMLTextAreaElement>(null)
  const onCheckRef = useRef(onCheck); onCheckRef.current = onCheck
  const prefsRef = useRef(prefs); prefsRef.current = prefs
  const navigation = useRef(0)
  const mounted = useRef(true)
  const saveError = useAgentSaveError()
  const discovery = useAgentDiscovery(host)
  const current = allThreads.find(row => row.executionId === selected && row.meta.hostKey === host) || null
  const threads = allThreads.filter(row => row.meta.hostKey === host && !!row.meta.archivedAt === archived && (!query || `${threadTitle(row)} ${row.meta.folder} ${row.agentName}`.toLowerCase().includes(query.toLowerCase())))
  const items = useMemo(() => conversation(current?.transcript || []), [current?.transcript])
  const plan = current?.transcript.slice().reverse().find(event => event.type === "plan")?.plan
  const draft = current ? current.meta.draft : prefs.draft
  const agentId = current?.agentId || prefs.agent
  const definition = AGENTS.find(provider => provider.id === agentId) || AGENTS[0]
  const available = discovery.agents.find(provider => provider.agentId === prefs.agent)
  const folder = current?.meta.folder || prefs.folder
  const fields = current?.configOptions || []
  const canSend = connected && !busy && !configBusy && !!draft.trim() && (current ? idle(current) && !current.meta.archivedAt : !discovery.checking && available?.available === true)
  const folders = [...new Set([...prefs.folders, ...threads.map(row => row.meta.folder)])].filter(path => !query || threads.some(row => row.meta.folder === path))
  const sortedFolders = folders.sort((a, b) => prefs.sort === "name" ? folderName(a).localeCompare(folderName(b)) : prefs.sort === "manual" ? (prefs.folderOrder.indexOf(a) < 0 ? 999 : prefs.folderOrder.indexOf(a)) - (prefs.folderOrder.indexOf(b) < 0 ? 999 : prefs.folderOrder.indexOf(b)) : Math.max(0, ...threads.filter(row => row.meta.folder === b).map(row => row.meta.activityAt)) - Math.max(0, ...threads.filter(row => row.meta.folder === a).map(row => row.meta.activityAt)))
  const setDraft = (text: string) => current ? updateThreadMeta(current.executionId, { draft: text }) : setPrefs(old => ({ ...old, draft: text }))

  useEffect(() => { claimAgentThreads(session, relatedSessionIds || [session.id]) }, [host, session.id, relatedSessionIds?.join("|")])
  useEffect(() => { saveWorkspace(host, { ...prefs, selectedId: selected || undefined }) }, [host, prefs, selected])
  useEffect(() => {
    if (!connected) return
    void discoverAgents(host, async () => {
      const paths = prefsRef.current.executables
      if (Object.values(paths).some(Boolean)) return (await Promise.all(AGENTS.map(provider => onCheckRef.current(provider.id, paths[provider.id]?.trim() || undefined)))).flat()
      return onCheckRef.current()
    })
  }, [host, connected])
  useEffect(() => {
    if (!discovery.checkedAt || current) return
    if (!discovery.agents.some(provider => provider.agentId === prefs.agent && provider.available)) {
      const first = discovery.agents.find(provider => provider.available)
      if (first) setPrefs(old => ({ ...old, agent: first.agentId }))
    }
  }, [discovery.checkedAt])
  useEffect(() => {
    if (selected) void subscribeRemoteAgent(selected)
    setFollowing(true); setError(null); setMenu(null); setCommandOpen(false)
  }, [selected])
  useEffect(() => { if (following && log.current) log.current.scrollTop = log.current.scrollHeight }, [current?.lastSequence, selected, following, setup])
  useEffect(() => { const input = textarea.current; if (input) { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 170)}px` } }, [draft, selected])
  useEffect(() => { mounted.current = true; const previous = document.activeElement as HTMLElement | null; surface.current?.focus(); return () => { mounted.current = false; previous?.focus() } }, [])
  useEffect(() => {
    if (!deleting) return
    const previous = document.activeElement as HTMLElement | null
    surface.current?.querySelector<HTMLButtonElement>('.agent-confirm button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [deleting])

  const run = async (operation: () => Promise<unknown>) => { setBusy(true); setError(null); try { await operation() } catch (e) { setError(messageOf(e)) } finally { setBusy(false) } }
  const check = () => discoverAgents(host, async () => (await Promise.all(AGENTS.map(provider => onCheckRef.current(provider.id, prefs.executables[provider.id]?.trim() || undefined)))).flat())
  const selectThread = (row: AgentThreadRow) => { navigation.current++; setSelected(row.executionId); setSetup(false); setMobileSidebar(false); setPrefs(old => ({ ...old, folder: row.meta.folder })) }
  const newThread = (path = prefs.folder) => { navigation.current++; setSelected(null); setSetup(false); setArchived(false); setMobileSidebar(false); setError(null); setPrefs(old => ({ ...old, folder: path, draft: "" })) }
  const start = async () => {
    const launch = { ...prefs }, revision = navigation.current
    let owned = false
    const created = (row: AgentThreadRow) => {
      if (owned) return
      owned = true
      const resolved = normalizeFolder(row.cwd)
      const latestDraft = navigation.current === revision ? prefsRef.current.draft : launch.draft
      updateThreadMeta(row.executionId, { hostKey: host, folder: resolved, draft: latestDraft })
      if (!mounted.current || navigation.current !== revision) return
      setSelected(row.executionId)
      setPrefs(old => ({ ...old, folder: resolved, draft: "", folders: [...new Set([...old.folders.filter(path => path !== launch.folder), resolved])] }))
    }
    const row = await onStart(launch.agent, { cwd: launch.folder, executable: launch.executables[launch.agent]?.trim() || undefined }, created)
    created(row)
    return row
  }
  const send = async () => {
    if (!canSend) return
    const text = draft.trim(), revision = navigation.current
    await run(async () => {
      const row = current || await start()
      if (!idle(row)) { updateThreadMeta(row.executionId, { draft: text }); return }
      await sendAgentMessage(row.executionId, text)
      clearAgentDraft(row.executionId, text)
      if (navigation.current === revision && mounted.current) setFollowing(true)
    })
  }
  const changeConfig = async (id: string, value: string | boolean) => {
    if (!current || configBusy) return
    setConfigBusy(true); setError(null)
    try { await setAgentConfig(current.executionId, id, value) } catch (e) { setError(messageOf(e)) } finally { setConfigBusy(false) }
  }
  const resume = async () => {
    if (!current) return
    const target = current, revision = navigation.current
    await run(async () => {
      const next = await resumeAgentThread(target.executionId, onStart, prefs.executables[target.agentId]?.trim() || undefined)
      if (mounted.current && navigation.current === revision) setSelected(next.executionId)
    })
  }
  const archiveThread = (row: AgentThreadRow) => {
    setUndo({ id: row.executionId, at: row.meta.archivedAt })
    updateThreadMeta(row.executionId, { archivedAt: row.meta.archivedAt ? undefined : Date.now() })
    if (current?.executionId === row.executionId) { navigation.current++; setSelected(null) }
    setMenu(null)
  }
  const moveThread = (row: AgentThreadRow, delta: number) => {
    const siblings = threads.filter(thread => thread.meta.folder === row.meta.folder).sort((a, b) => b.meta.order - a.meta.order)
    const index = siblings.indexOf(row), other = siblings[index + delta]
    if (!other) return
    const order = row.meta.order; updateThreadMeta(row.executionId, { order: other.meta.order }); updateThreadMeta(other.executionId, { order })
    setPrefs(old => ({ ...old, sort: "manual" })); setMenu(null)
  }
  const moveFolder = (path: string, delta: number) => {
    const next = [...sortedFolders], index = next.indexOf(path), target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setPrefs(old => ({ ...old, sort: "manual", folderOrder: next })); setProjectMenu(null)
  }

  return <section ref={surface} tabIndex={-1} className="agent-workspace" role="dialog" aria-modal="true" aria-label={`Agents on ${session.name}`} onPointerDown={e => { if (!(e.target as HTMLElement).closest(".agent-thread-menu,.agent-thread-more")) { setMenu(null); setProjectMenu(null) } }} onKeyDown={e => {
    e.stopPropagation()
    if (e.key === "Escape") { e.preventDefault(); if (deleting) setDeleting(null); else if (rename) setRename(null); else if (commandOpen) setCommandOpen(false); else if (advanced) setAdvanced(false); else if (setup) setSetup(false); else if (menu || projectMenu) { setMenu(null); setProjectMenu(null) } else if (folderMenu) setFolderMenu(false); else if (mobileSidebar) setMobileSidebar(false); else onClose() }
    if (e.key === "Tab") {
      const focusRoot = deleting ? surface.current?.querySelector('.agent-confirm') : surface.current
      const elements = [...(focusRoot?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href]') || [])].filter(element => element.getClientRects().length)
      if (e.shiftKey && (document.activeElement === elements[0] || document.activeElement === surface.current)) { e.preventDefault(); elements[elements.length - 1]?.focus() }
      else if (!e.shiftKey && document.activeElement === elements[elements.length - 1]) { e.preventDefault(); elements[0]?.focus() }
    }
  }}>
    <aside className={`agent-sidebar ${mobileSidebar ? "is-open" : ""}`} aria-label="Projects and conversations">
      <div className="agent-sidebar-top"><button className="agent-icon-button" aria-label="Back to workspace" onClick={onClose}><AgentIcon name="panel" /></button><span>Still</span><button className="agent-icon-button" aria-label="New conversation" onClick={() => newThread()}><AgentIcon name="edit" /></button></div>
      <button className="agent-server" onClick={() => setSetup(true)} title={`${session.username}@${session.host}:${session.port}`}><span className={`agent-status-dot ${connected ? "connected" : ""}`} /><span>{session.name}</span><AgentIcon name="chevron" size={12} style={{ transform: "rotate(90deg)" }} /></button>
      <label className="agent-sidebar-search"><AgentIcon name="search" size={14} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={e => setQuery(e.target.value)} /><kbd>⌕</kbd></label>
      <div className="agent-project-heading"><span>{archived ? "Archived" : "Projects"}</span><select aria-label="Sort projects and conversations" value={prefs.sort} onChange={e => setPrefs(old => ({ ...old, sort: e.target.value as typeof old.sort }))}><option value="recent">Recent</option><option value="name">A–Z</option><option value="manual">Manual</option></select><button className="agent-icon-button" aria-label="Add project folder" onClick={() => { setFolderMenu(true); setSetup(false) }}><AgentIcon name="plus" size={14} /></button></div>
      <nav className="agent-thread-list" aria-label="Conversations by folder">{sortedFolders.map(path => {
        const collapsed = prefs.collapsed.includes(path) && !query
        const rows = threads.filter(row => row.meta.folder === path).sort((a, b) => Number(b.meta.pinned) - Number(a.meta.pinned) || (prefs.sort === "name" ? threadTitle(a).localeCompare(threadTitle(b)) : prefs.sort === "manual" ? b.meta.order - a.meta.order : b.meta.activityAt - a.meta.activityAt))
        if (archived && !rows.length) return null
        return <div className="agent-folder" key={path}>
          <div className="agent-folder-heading"><button aria-expanded={!collapsed} className="agent-folder-toggle" title={path} onClick={() => setPrefs(old => ({ ...old, collapsed: collapsed ? old.collapsed.filter(folder => folder !== path) : [...old.collapsed, path] }))}><AgentIcon name="chevron" size={11} style={{ transform: collapsed ? "" : "rotate(90deg)" }} /><AgentIcon name="folder" size={15} /><span>{folderName(path)}</span></button><button className="agent-icon-button" aria-label={`New conversation in ${path}`} onClick={() => newThread(path)}><AgentIcon name="plus" size={13} /></button><button className="agent-icon-button agent-thread-more" aria-label={`Project actions for ${path}`} aria-expanded={projectMenu === path} onClick={() => setProjectMenu(projectMenu === path ? null : path)}><AgentIcon name="more" size={13} /></button>
            {projectMenu === path && <div className="agent-thread-menu" role="menu"><button role="menuitem" onClick={() => moveFolder(path, -1)}>Move project up</button><button role="menuitem" onClick={() => moveFolder(path, 1)}>Move project down</button><button role="menuitem" disabled={allThreads.some(row => row.meta.hostKey === host && row.meta.folder === path)} onClick={() => { setPrefs(old => ({ ...old, folders: old.folders.filter(folder => folder !== path), folderOrder: old.folderOrder.filter(folder => folder !== path) })); setProjectMenu(null) }}>Remove empty folder</button></div>}
          </div>
          {!collapsed && <div className="agent-folder-threads">{rows.map(row => <div key={row.meta.id} className={`agent-thread ${selected === row.executionId ? "is-selected" : ""}`} onContextMenu={e => { e.preventDefault(); setMenu(row.executionId) }}>
            {rename?.id === row.executionId ? <form className="agent-rename" onSubmit={e => { e.preventDefault(); updateThreadMeta(row.executionId, { title: rename.title.trim() }); setRename(null) }}><input autoFocus aria-label="Conversation name" value={rename.title} onChange={e => setRename({ ...rename, title: e.target.value })} onBlur={() => { updateThreadMeta(row.executionId, { title: rename.title.trim() }); setRename(null) }} /></form>
               : <button className="agent-thread-open" aria-current={selected === row.executionId ? "page" : undefined} title={`${threadTitle(row)} · ${status(row)}`} onClick={() => selectThread(row)}><span className={`agent-thread-indicator ${row.pendingPermission || row.pendingInput ? "attention" : row.turnActive ? "working" : ""}`}>{row.meta.pinned ? <AgentIcon name="pin" size={12} /> : <AgentIcon name="chat" size={13} />}</span><span className="agent-thread-title">{threadTitle(row)}</span>{(row.pendingPermission || row.pendingInput) && <span className="agent-attention-label">Needs you</span>}</button>}
            <button className="agent-icon-button agent-thread-more" aria-label={`Actions for ${threadTitle(row)}`} aria-expanded={menu === row.executionId} onClick={() => setMenu(menu === row.executionId ? null : row.executionId)}><AgentIcon name="more" size={14} /></button>
            {menu === row.executionId && <div className="agent-thread-menu" role="menu"><button role="menuitem" onClick={() => { setRename({ id: row.executionId, title: threadTitle(row) }); setMenu(null) }}><AgentIcon name="edit" />Rename</button><button role="menuitem" onClick={() => { updateThreadMeta(row.executionId, { pinned: !row.meta.pinned }); setMenu(null) }}><AgentIcon name="pin" />{row.meta.pinned ? "Unpin" : "Pin"}</button>
              <button role="menuitem" onClick={() => moveThread(row, -1)}>Move up</button><button role="menuitem" onClick={() => moveThread(row, 1)}>Move down</button><hr /><button role="menuitem" disabled={row.turnActive} onClick={() => archiveThread(row)}><AgentIcon name="archive" />{row.meta.archivedAt ? "Restore" : "Archive"}</button><button role="menuitem" className="is-destructive" onClick={() => { setDeleting(row); setMenu(null) }}><AgentIcon name="trash" />Delete</button></div>}
          </div>)}{!rows.length && <button className="agent-empty-folder" onClick={() => newThread(path)}>Start a conversation</button>}</div>}
        </div>
      })}{query && !threads.length && <p className="agent-sidebar-empty">No matching conversations.</p>}</nav>
      <div className="agent-sidebar-footer"><button className={archived ? "is-active" : ""} onClick={() => setArchived(!archived)}><AgentIcon name="archive" />{archived ? "All conversations" : "Archived"}<span>{allThreads.filter(row => row.meta.hostKey === host && row.meta.archivedAt).length || ""}</span></button><button onClick={() => setSetup(!setup)}><AgentIcon name="settings" />Agent settings</button><button onClick={onOpenTerminal}><AgentIcon name="terminal" />Terminal<AgentIcon name="chevron" size={12} /></button></div>
    </aside>
    <main className="agent-main">
      <header className="agent-topbar" data-tauri-drag-region><div className="agent-breadcrumb"><button className="agent-icon-button agent-mobile-menu" aria-label="Toggle projects" aria-expanded={mobileSidebar} onClick={() => setMobileSidebar(!mobileSidebar)}><AgentIcon name="panel" /></button><AgentIcon name="folder" size={14} /><button title={folder} onClick={() => setFolderMenu(!folderMenu)}>{folderName(folder)}</button><span>/</span><strong>{setup ? "Agent settings" : current ? threadTitle(current) : "New conversation"}</strong></div>
        <div className="agent-topbar-actions">{current && <span className="agent-status" role="status"><span className={`agent-status-dot ${current.turnActive ? "working" : ""}`} />{status(current)}</span>}<button className="agent-icon-button" aria-label="Open terminal" onClick={onOpenTerminal}><AgentIcon name="terminal" /></button><button className="agent-icon-button" aria-label="Close agent workspace" onClick={onClose}><AgentIcon name="close" /></button></div></header>
      {folderMenu && <form className="agent-folder-picker" onSubmit={e => { e.preventDefault(); navigation.current++; const form = new FormData(e.currentTarget); const path = normalizeFolder(String(form.get("folder") || "~")); setPrefs(old => ({ ...old, folder: path, folders: [...new Set([...old.folders, path])] })); setSelected(null); setFolderMenu(false) }}><label className="agent-field">Remote project folder<input autoFocus name="folder" aria-label="Remote project folder" defaultValue={prefs.folder} placeholder="~/projects/my-app" /></label><div className="agent-inline-actions"><button className="agent-primary">Open folder</button><button type="button" className="agent-button" onClick={() => setFolderMenu(false)}>Cancel</button></div></form>}
      {setup ? <section className="agent-setup">
        <div className="agent-settings-heading"><h1>Agents on {session.name}</h1><p>{session.username}@{session.host}</p><button className="agent-button" disabled={!connected || discovery.checking} onClick={() => void check()}><AgentIcon name="refresh" size={14} />{discovery.checking ? "Checking…" : "Refresh"}</button></div>
        {connectionNotice}
        <div className="agent-settings-list">{AGENTS.map(provider => {
          const info = discovery.agents.find(row => row.agentId === provider.id)
           return <details className="agent-provider-setting" key={provider.id}><summary><span className={`agent-provider-logo provider-${provider.id}`}>{provider.label.slice(0, 1)}</span><span><strong>{provider.label}</strong><small>{info?.installed ? info.available ? info.runtime === "acp" ? "Installed · ACP connection" : "Installed · native connection" : info.message || "Integration unavailable" : discovery.checking ? "Checking installation…" : info ? "Not found" : "Not checked"}</small></span><AgentIcon name="chevron" size={13} /></summary>
            <div className="agent-provider-details"><p>{provider.note}</p><label className="agent-field">Executable path<input aria-label={`${provider.label} executable path`} value={prefs.executables[provider.id] || ""} placeholder={info?.executable || provider.executable} onChange={e => setPrefs(old => ({ ...old, executables: { ...old.executables, [provider.id]: e.target.value } }))} /></label>
              {!info?.installed && <><span>Install on the server</span><code className="agent-install-command">{provider.installCommand}</code></>}<span>Sign in on the server</span><code className="agent-install-command">{provider.loginCommand}</code><button className="agent-button" onClick={onOpenTerminal}><AgentIcon name="terminal" size={14} />Open terminal</button></div></details>
        })}</div>{discovery.error && <p className="agent-error" role="alert">{discovery.error}</p>}<button className="agent-button" onClick={() => setSetup(false)}>Back to conversation</button>
      </section> : <>
        <div ref={log} className="agent-conversation" aria-label="Conversation" onScroll={() => { const el = log.current; if (el) setFollowing(el.scrollHeight - el.clientHeight - el.scrollTop < 70) }}>
          <div className="agent-message-list">{!current ? <div className="agent-welcome"><span className="agent-welcome-mark"><AgentIcon name="code" size={25} /></span><h1>What are we working on?</h1><p>Start a conversation in <button onClick={() => setFolderMenu(true)}>{folderName(prefs.folder)}<AgentIcon name="chevron" size={11} style={{ transform: "rotate(90deg)" }} /></button></p><div className="agent-prompt-suggestions">{["Explore this project", "Review recent changes", "Help me fix a bug"].map(text => <button key={text} onClick={() => { setDraft(text); textarea.current?.focus() }}>{text}<AgentIcon name="arrow" size={12} style={{ transform: "rotate(45deg)" }} /></button>)}</div></div>
            : <><AgentTimeline items={items} agentName={current.agentName} plan={plan} />{!items.length && <div className="agent-thread-empty"><AgentIcon name="chat" size={23} /><h2>{current.state === "connecting" ? `Connecting ${current.agentName}…` : idle(current) ? `${current.agentName} is ready` : canResumeAgentThread(current) ? "Saved conversation" : "Agent connection unavailable"}</h2><p>{current.state === "connecting" ? "Loading the models and commands from your server." : idle(current) ? "Send a message to get started." : "Review the connection status below before continuing."}</p></div>}{current.turnActive && !current.pendingPermission && !current.pendingInput && <div className="agent-working" role="status"><span className="agent-status-dot working" />{current.lastError?.includes("Cancellation") ? "Stopping…" : "Working…"}</div>}</>}
          </div>
        </div>
        <div className="agent-composer-area">{!following && current && <button className="agent-jump" onClick={() => setFollowing(true)}>Latest activity <AgentIcon name="arrow" size={12} style={{ transform: "rotate(180deg)" }} /></button>}
          {connectionNotice}
          {saveError && <div className="agent-error" role="alert">{saveError}</div>}
          {discovery.error && <div className="agent-error" role="alert">{discovery.error}<button className="agent-button" disabled={!connected || discovery.checking} onClick={() => void check()}>Retry detection</button></div>}
          {current?.pendingPermission && <PermissionCard request={current.pendingPermission} busy={busy} respond={option => void run(() => respondAgentPermission(current.executionId, current.pendingPermission!.requestId, option))} />}
          {current?.pendingInput && <InputCard key={String(current.pendingInput.requestId)} request={current.pendingInput} busy={busy} respond={answers => void run(() => nativeBridge.agentRespondInput(current.executionId, current.pendingInput!.requestId, answers))} />}
          {(error || current?.lastError && ["error", "submissionUnknown"].includes(current.state)) && <div className="agent-error" role="alert"><span>{error || current?.lastError}</span>{current && canResumeAgentThread(current) ? <button className="agent-button" disabled={busy || !connected} onClick={() => void resume()}>Resume conversation</button> : <button className="agent-link-button" onClick={() => setSetup(true)}>Agent settings</button>}</div>}
          <form className="agent-composer" onSubmit={e => { e.preventDefault(); void send() }}>
            {commandOpen && <CommandPicker commands={current?.commands || []} query={commandQuery} onQuery={setCommandQuery} onSelect={command => { setDraft(`/${command.name} `); setCommandOpen(false); textarea.current?.focus() }} onClose={() => { setCommandOpen(false); textarea.current?.focus() }} />}
            <textarea ref={textarea} aria-label="Message agent" rows={2} placeholder={connected ? "Ask anything, or describe what you'd like to build…" : "Your message will be ready when the server connects…"} value={draft} onChange={e => { setDraft(e.target.value); if (e.target.value === "/" && current) { setCommandQuery(""); setCommandOpen(true) } }} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
            <div className="agent-composer-toolbar"><div className="agent-composer-controls">
               {!current ? <div className="agent-provider-picker"><span className={`agent-provider-symbol provider-${prefs.agent}`}>{definition.label.slice(0, 1)}</span><select aria-label="Agent" value={prefs.agent} onChange={e => setPrefs(old => ({ ...old, agent: e.target.value }))}>{AGENTS.map(provider => { const found = discovery.agents.find(info => info.agentId === provider.id); return <option key={provider.id} value={provider.id}>{provider.label}{found ? found.available ? "" : found.installed ? " · integration needed" : " · not installed" : discovery.checking ? " · checking…" : " · not checked"}</option> })}</select></div>
                : <span className="agent-composer-provider"><span className={`agent-provider-symbol provider-${current.agentId}`}>{definition.label.slice(0, 1)}</span>{current.agentName}</span>}
              {fields.filter(option => option.category === "model").map(option => <ConfigPicker key={option.id} option={option} disabled={!idle(current) || busy || configBusy} change={(id, value) => void changeConfig(id, value)} />)}
              <button type="button" className="agent-icon-button" aria-label="Conversation settings" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><AgentIcon name="settings" size={15} /></button>
              {!!current && <button type="button" className="agent-icon-button" aria-label="Commands" aria-expanded={commandOpen} onClick={() => { setCommandQuery(""); setCommandOpen(!commandOpen) }}><AgentIcon name="command" size={14} /></button>}
              {configBusy && <span className="agent-muted" role="status">Saving…</span>}
            </div>{current?.turnActive ? <button className="agent-send agent-stop" type="button" aria-label="Stop agent" disabled={busy} onClick={() => void run(() => cancelAgentTurn(current.executionId))}><AgentIcon name="stop" size={15} /></button> : <button className="agent-send" type="submit" aria-label="Send message" disabled={!canSend}><AgentIcon name="arrow" size={18} /></button>}</div>
            {advanced && <div className="agent-advanced"><div className="agent-advanced-header"><strong>Conversation settings</strong><button type="button" className="agent-icon-button" aria-label="Close conversation settings" onClick={() => setAdvanced(false)}><AgentIcon name="close" size={13} /></button></div>{fields.filter(option => option.category !== "model").map(option => <div className="agent-setting-row" key={option.id}><span>{option.name}</span><ConfigPicker option={option} disabled={!idle(current) || busy || configBusy} change={(id, value) => void changeConfig(id, value)} /></div>)}{!fields.length && <p>Connect an agent to load its available settings.</p>}<div className="agent-setting-row"><span>Project folder</span><code>{folder}</code></div>{current && <button type="button" className="agent-button" disabled={busy} onClick={() => void run(() => refreshAgentThread(current.executionId))}><AgentIcon name="refresh" size={13} />Refresh session</button>}{!current && <button className="agent-button" type="button" disabled={busy || !available?.available || !connected} onClick={() => void run(start)}>Connect {definition.label}</button>}</div>}
          </form>
          <div className="agent-composer-footnote"><span>{discovery.checking && !current ? "Finding your installed agents…" : !current && !available?.available && connected ? <button onClick={() => setSetup(true)}>Set up an agent to continue</button> : "Enter to send · Shift+Enter for a new line"}</span><span title="Agent execution currently depends on this SSH connection">{session.host}</span></div>
        </div>
      </>}
      {undo && <div className="agent-toast" role="status">Conversation {undo.at ? "restored" : "archived"}<button onClick={() => { updateThreadMeta(undo.id, { archivedAt: undo.at }); setUndo(null) }}>Undo</button><button className="agent-icon-button" aria-label="Dismiss notification" onClick={() => setUndo(null)}><AgentIcon name="close" size={12} /></button></div>}
    </main>
    {deleting && <div className="agent-confirm-backdrop"><section className="agent-confirm" role="alertdialog" aria-labelledby="agent-delete-title"><AgentIcon name="trash" size={22} /><h2 id="agent-delete-title">Delete this conversation?</h2><p>“{threadTitle(deleting)}” will be removed from Still. Project files, terminal sessions, and the agent’s own saved history are kept.</p>{deleting.turnActive && <p>Stop the agent before deleting this conversation.</p>}<div className="agent-inline-actions"><button className="agent-button" onClick={() => setDeleting(null)}>Cancel</button>{deleting.turnActive ? <button className="agent-primary" disabled={busy} onClick={() => void run(async () => { await cancelAgentTurn(deleting.executionId); setDeleting(null) })}>Stop agent</button> : <button className="agent-danger" disabled={busy} onClick={() => void run(async () => { await deleteAgentThread(deleting.executionId); if (selected === deleting.executionId) setSelected(null); setDeleting(null) })}>Delete conversation</button>}</div></section></div>}
  </section>
}
