import { useEffect, useId, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent } from "react"
import type { AgentThreadRow } from "../session/agentThreads"
import { cancelAgentTurn, sendAgentMessage, sharedUnread, threadTitle } from "../session/agentThreads"
import AgentIcon from "./AgentIcon"
import AgentProviderMark from "./AgentProviderMark"

const GUIDE_LIMIT = 4000
interface GuideState { open?: boolean; sending?: boolean; error?: string; sent?: boolean }
const messageOf = (error: unknown) => error && typeof error === "object" && "message" in error ? String(error.message) : String(error || "The request failed.")

const hasPending = (row: AgentThreadRow) => !!(row.pendingPermission || row.pendingInput)
// Stop applies where the main chat's Stop button does (an active turn), plus open requests that a cancel resolves.
const stoppable = (row: AgentThreadRow) => row.turnActive || hasPending(row)
const needsAttention = (row: AgentThreadRow) => hasPending(row) || ["error", "submissionUnknown"].includes(row.state)
// A "working" state with no active turn is a connected, idle child, so it is not in flight.
const inFlight = (row: AgentThreadRow) => stoppable(row) || ["connecting", "inputRequired", "detached", "rewinding"].includes(row.state)
// A settled child whose latest activity the user has not opened yet. Only the chat's own read path clears it (see markAgentThreadRead);
// expanding the details here never does. Failed children already read as "needs you", and deleted ones can never be marked read.
const newResult = (row: AgentThreadRow) => sharedUnread(row) && !inFlight(row) && !needsAttention(row) && !row.meta.subagentPrepared && !row.meta.sharedDeleted && row.transcript.some(event => event.type === "threadComplete")
// An unattached child (not opened since the app started) reports no live status, only that
// something happened since it was last read. That is activity, not a confirmed result.
const unreadActivity = (row: AgentThreadRow) => sharedUnread(row) && ["detached", "saved"].includes(row.state) && !row.meta.subagentPrepared && !row.meta.sharedDeleted
const newLabel = (row: AgentThreadRow) => newResult(row) ? "New result" : unreadActivity(row) ? "New activity" : null
const isFinished = (row: AgentThreadRow) => !inFlight(row) && !needsAttention(row) && !row.meta.subagentPrepared && !row.meta.subagentGuidance?.length && !newResult(row)
// Same gate as sendAgentMessage, so Guide never starts a turn that the runtime would refuse.
const idle = (row: AgentThreadRow) => !row.meta.sharedDeleted && !(row.remoteImported && !row.continuity) && !row.recoveryReason && !row.turnActive && !hasPending(row) && !row.meta.submissionUnknown && ["working", "complete", "cancelled", "error"].includes(row.state)
const stopSignature = (row: AgentThreadRow) => [row.state, row.turnActive, !!row.pendingPermission, !!row.pendingInput].join("|")

function guideBlock(row: AgentThreadRow): string | null {
  if (hasPending(row)) return "Can't send guidance while this subagent is waiting for your answer or approval. Open its chat to respond."
  if (row.turnActive) return "Can't send guidance while this subagent is working. Open its chat to follow up."
  if (row.meta.subagentPrepared) return "This subagent has no task yet. Open its chat to give it one."
  if (row.meta.subagentGuidance?.length) return "Guidance from the parent agent is already queued for this subagent. Open its chat to follow up."
  if (!idle(row)) return "This subagent can't take a message right now. Open its chat to reconnect or recover it."
  return null
}

function settingValue(row: AgentThreadRow, kinds: string[], ids: string[]) {
  const option = row.configOptions.find(item => kinds.includes(item.category || "") || ids.includes(item.id))
  if (!option) return "Not reported"
  const value = (option.options || []).flatMap(item => "value" in item ? [item] : item.options).find(item => item.value === option.currentValue)
  return String(value?.name ?? option.currentValue)
}

const statusOf = (row: AgentThreadRow, stopRequested: boolean) => {
  const base = row.pendingPermission || row.pendingInput
    ? "Needs you"
    : row.meta.subagentPrepared ? "Prepared · no task sent"
    : row.meta.subagentGuidancePaused && row.meta.subagentGuidance?.length ? "Guidance paused"
      : row.meta.subagentGuidance?.length ? "Guidance queued"
    : row.state === "submissionUnknown" ? "Uncertain"
      : row.state === "error" ? "Turn failed"
        : row.turnActive ? "Working"
          : row.state === "detached" || row.state === "saved" ? "Saved"
            : row.state === "cancelled" ? "Stopped"
              : "Ready"
  return stopRequested ? `Stop requested · ${base}` : base
}
const dotClass = (row: AgentThreadRow) => row.pendingPermission || row.pendingInput ? " is-attention" : ["error", "submissionUnknown"].includes(row.state) ? " is-error" : row.turnActive ? " is-working" : ""

export default function AgentSubagents({ children, onOpen, onCreate }: {
  children: AgentThreadRow[]
  onOpen: (row: AgentThreadRow) => void
  onCreate: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [finishedOpen, setFinishedOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [guides, setGuides] = useState<Record<string, GuideState>>({})
  const [stopRequests, setStopRequests] = useState<Record<string, string>>({})
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({})
  const [confirmAll, setConfirmAll] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const pendingFocus = useRef<string[] | null>(null)
  const stopping = useRef(new Set<string>())
  const guiding = useRef(new Set<string>())
  const detailsBase = useId()
  const finishedId = useId()

  // Returns focus to a surviving control after the element that held it unmounts.
  useEffect(() => {
    const keys = pendingFocus.current
    if (!keys) return
    pendingFocus.current = null
    for (const key of keys) {
      const target = panel.current?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)
      if (target) { target.focus(); return }
    }
  })
  // "Stop requested" holds only while the row still looks the way it did when Stop was pressed.
  useEffect(() => {
    setStopRequests(old => {
      const next = { ...old }
      let changed = false
      for (const id of Object.keys(old)) {
        const row = children.find(item => item.meta.id === id)
        if (!row || stopSignature(row) !== old[id]) { delete next[id]; changed = true }
      }
      return changed ? next : old
    })
  }, [children])
  const stoppableCount = children.filter(stoppable).length
  useEffect(() => { if (confirmAll && !stoppableCount) setConfirmAll(false) }, [confirmAll, stoppableCount])

  if (!children.length) return null
  const requested = (row: AgentThreadRow) => stopRequests[row.meta.id] === stopSignature(row) || row.turnActive && /cancellation/i.test(row.lastError || "")
  const active = children.filter(inFlight).length
  const attention = children.filter(needsAttention).length
  const fresh = children.filter(row => !!newLabel(row)).length
  const top = children.filter(row => !isFinished(row))
  const finished = children.filter(isFinished)
  const finishedVisible = finishedOpen || (openId !== null && finished.some(row => row.meta.id === openId))
  const requestedCount = children.filter(row => stoppable(row) && requested(row)).length

  const focusAfter = (...keys: string[]) => { pendingFocus.current = keys }
  const patchGuide = (id: string, patch: GuideState) => setGuides(old => ({ ...old, [id]: { ...old[id], ...patch } }))
  const select = (next: string | null) => {
    if (openId && openId !== next) patchGuide(openId, { sent: false })
    setOpenId(next)
  }
  const closeDetails = (id: string) => { focusAfter(`${id}:row`); select(null) }
  const toggleFinished = () => {
    if (finishedVisible) {
      setFinishedOpen(false)
      if (openId !== null && finished.some(row => row.meta.id === openId)) select(null)
    } else setFinishedOpen(true)
  }

  // Resolves to an error message, or null once cancellation has been requested. It never claims the child stopped.
  async function stop(row: AgentThreadRow): Promise<string | null> {
    const id = row.meta.id
    if (stopping.current.has(id)) return null
    stopping.current.add(id)
    setStopErrors(old => { if (!(id in old)) return old; const { [id]: _removed, ...rest } = old; return rest })
    setStopRequests(old => ({ ...old, [id]: stopSignature(row) }))
    try { await cancelAgentTurn(row.executionId); return null }
    catch (error) {
      const message = messageOf(error)
      setStopRequests(old => { const { [id]: _removed, ...rest } = old; return rest })
      setStopErrors(old => ({ ...old, [id]: message }))
      return message
    } finally { stopping.current.delete(id) }
  }
  async function stopAll() {
    const targets = children.filter(row => stoppable(row) && !requested(row))
    focusAfter("stop-all", "toggle")
    setConfirmAll(false)
    await Promise.all(targets.map(stop))
  }
  const guideOpen = (row: AgentThreadRow) => guides[row.meta.id]?.open ?? !!drafts[row.meta.id]
  const toggleGuide = (row: AgentThreadRow) => {
    const id = row.meta.id
    if (guideBlock(row)) return
    if (guideOpen(row)) { patchGuide(id, { open: false }); return }
    focusAfter(`${id}:field`)
    patchGuide(id, { open: true, sent: false, error: "" })
  }
  // Guidance is a user message, so it is only ever sent to an idle child; busy children never get a concurrent turn.
  async function sendGuide(row: AgentThreadRow) {
    const id = row.meta.id, text = (drafts[id] || "").trim()
    if (!text || text.length > GUIDE_LIMIT || guideBlock(row) || guiding.current.has(id)) return
    guiding.current.add(id)
    patchGuide(id, { sending: true, error: "" })
    try {
      await sendAgentMessage(row.executionId, text)
      setDrafts(old => ({ ...old, [id]: "" }))
      patchGuide(id, { open: false, sending: false, sent: true })
      focusAfter(`${id}:guide`, `${id}:row`)
    } catch (error) { patchGuide(id, { sending: false, error: messageOf(error) }) }
    finally { guiding.current.delete(id) }
  }
  const confirmKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault(); event.stopPropagation()
    focusAfter("stop-all"); setConfirmAll(false)
  }

  const renderRow = (row: AgentThreadRow) => {
    const id = row.meta.id, title = threadTitle(row), open = openId === id, isRequested = stoppable(row) && requested(row)
    const status = statusOf(row, isRequested), detailsId = `${detailsBase}-${id}`, marker = newLabel(row)
    // Escape anywhere in an open row (its summary button or its details) closes the details and returns focus to the row.
    const escapeClose = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing) return
      event.preventDefault(); event.stopPropagation(); closeDetails(id)
    }
    return <article className="agent-subagent" key={id} data-expanded={open} onKeyDown={open ? escapeClose : undefined}>
      <div className="agent-subagent-row">
        <button type="button" className="agent-subagent-summary" data-focus-key={`${id}:row`} aria-expanded={open} aria-controls={open ? detailsId : undefined} aria-label={`${title}, ${row.agentName}, ${status}${marker ? `, ${marker.toLowerCase()}` : ""}`} onClick={() => select(open ? null : id)}>
          <AgentProviderMark id={row.agentId} size={16} />
          <span className="agent-subagent-copy">
            <strong title={title}>{title}</strong>
            <span><span className={`agent-subagent-state${dotClass(row)}`} aria-hidden="true" />{row.agentName} · {status}{marker && <NewMarker label={marker} />}</span>
            {!!row.configOptions.length && <span className="agent-subagent-settings">{row.configOptions.filter(option => ["model", "effort", "thought_level", "reasoning", "mode", "agent_mode"].includes(option.category || "") || ["model", "effort", "mode"].includes(option.id)).map(option => {
              const value = (option.options || []).flatMap(item => "value" in item ? [item] : item.options).find(item => item.value === option.currentValue)
              return `${option.name}: ${value?.name || option.currentValue}`
            }).join(" · ")}</span>}
          </span>
          <AgentIcon name="chevron" size={12} style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }} />
        </button>
        {!open && <button type="button" className="agent-subagent-open" aria-label={`Open ${title} chat`} onClick={() => onOpen(row)}>Open chat</button>}
      </div>
      {open && <SubagentDetails
        row={row} id={detailsId} title={title} status={status} marker={marker} requested={isRequested} stopError={stopErrors[id]}
        guide={{ ...guides[id], open: guideOpen(row) }} draft={drafts[id] || ""} onDraft={value => { patchGuide(id, { sent: false }); setDrafts(old => ({ ...old, [id]: value })) }}
        onToggleGuide={() => toggleGuide(row)} onCancelGuide={() => patchGuide(id, { open: false })} onSendGuide={() => void sendGuide(row)}
        onOpenChat={() => onOpen(row)} onStop={() => void stop(row)} onClose={() => closeDetails(id)} />}
    </article>
  }

  return <section className="agent-subagents" ref={panel} aria-label="Subagent conversations">
    <div className="agent-subagents-heading">
      <button type="button" className="agent-subagents-toggle" data-focus-key="toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
        <span>Subagents</span>
        <span className="agent-subagents-count">{active ? `${active} active` : `${children.length}`}{attention ? ` · ${attention} needs you` : ""}{fresh ? ` · ${fresh} new` : ""}</span>
        <AgentIcon name="chevron" size={13} style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }} />
      </button>
      {stoppableCount > 0 && <button type="button" className="agent-subagents-stop-all" data-focus-key="stop-all" aria-expanded={confirmAll} aria-label="Stop all subagents in this chat" onClick={() => { focusAfter("stop-all-cancel"); setConfirmAll(open => !open) }}>Stop all</button>}
      <button type="button" className="agent-subagents-create" onClick={onCreate}>New subagent</button>
    </div>
    {confirmAll && stoppableCount > 0 && <div className="agent-subagents-confirm" role="group" aria-label="Confirm stopping all subagents" onKeyDown={confirmKeyDown}>
      <p>Ask {stoppableCount === 1 ? "the 1 working subagent" : `all ${stoppableCount} working subagents`} in this chat to stop? Other chats and idle subagents are not affected. File edits already made stay in place.</p>
      <div className="agent-subagents-confirm-actions">
        <button type="button" className="agent-subagents-confirm-cancel" data-focus-key="stop-all-cancel" onClick={() => { focusAfter("stop-all"); setConfirmAll(false) }}>Keep running</button>
        <button type="button" className="agent-subagents-confirm-stop" onClick={() => void stopAll()}>Stop {stoppableCount === 1 ? "1 subagent" : `${stoppableCount} subagents`}</button>
      </div>
    </div>}
    <p className="agent-subagents-note" role="status">{requestedCount ? `Stop requested for ${requestedCount === 1 ? "1 subagent" : `${requestedCount} subagents`}. Waiting for ${requestedCount === 1 ? "it" : "each"} to confirm.` : ""}</p>
    {!collapsed && <div className="agent-subagents-list">
      {top.map(renderRow)}
      {finished.length > 0 && <div className="agent-subagents-finished">
        <button type="button" className="agent-subagents-finished-toggle" data-focus-key="finished" aria-expanded={finishedVisible} aria-controls={finishedId} onClick={toggleFinished}>
          <AgentIcon name="chevron" size={11} style={{ transform: finishedVisible ? "rotate(90deg)" : "rotate(0deg)" }} />
          <span>Finished</span>{" "}<span className="agent-subagents-count">{finished.length}</span>
        </button>
        <div id={finishedId} hidden={!finishedVisible}>{finishedVisible && finished.map(renderRow)}</div>
      </div>}
    </div>}
  </section>
}

// Text plus a dot, so the marker never depends on color alone.
const NewMarker = ({ label }: { label: string }) => <span className="agent-subagent-new"><span className="agent-subagent-new-dot" aria-hidden="true" />{label}</span>

function SubagentDetails({ row, id, title, status, marker, requested, stopError, guide, draft, onDraft, onToggleGuide, onCancelGuide, onSendGuide, onOpenChat, onStop, onClose }: {
  row: AgentThreadRow
  id: string
  title: string
  status: string
  marker: string | null
  requested: boolean
  stopError?: string
  guide: GuideState & { open: boolean }
  draft: string
  onDraft: (value: string) => void
  onToggleGuide: () => void
  onCancelGuide: () => void
  onSendGuide: () => void
  onOpenChat: () => void
  onStop: () => void
  onClose: () => void
}) {
  const key = row.meta.id
  const block = guideBlock(row)
  const canStop = stoppable(row)
  const submit = (event: FormEvent) => { event.preventDefault(); onSendGuide() }

  return <div className="agent-subagent-details" id={id} role="group" aria-label={`Details for ${title}`}>
    <dl className="agent-subagent-facts">
      <div><dt>Agent</dt><dd>{row.agentName}</dd></div>
      <div><dt>Status</dt><dd><span className={`agent-subagent-state${dotClass(row)}`} aria-hidden="true" />{status}{marker && <NewMarker label={marker} />}</dd></div>
      <div><dt>Model</dt><dd>{settingValue(row, ["model"], ["model"])}</dd></div>
      <div><dt>Effort</dt><dd>{settingValue(row, ["thought_level", "reasoning", "effort", "variant", "variants"], [])}</dd></div>
      <div><dt>Mode</dt><dd>{settingValue(row, ["mode", "agent", "agent_mode"], [])}</dd></div>
    </dl>
    <div className="agent-subagent-actions">
      <button type="button" className="agent-subagent-action" data-focus-key={`${key}:guide`} aria-expanded={guide.open} aria-disabled={block ? true : undefined} aria-describedby={block ? `${id}-hint` : undefined} onClick={onToggleGuide}>Guide</button>
      <button type="button" className="agent-subagent-action" aria-label={`Open ${title} chat`} onClick={onOpenChat}>Open chat</button>
      <button type="button" className="agent-subagent-action is-stop" aria-label={requested ? `Stop requested for ${title}` : `Stop ${title}`} aria-describedby={`${id}-stop-note`} aria-disabled={!canStop || requested ? true : undefined} onClick={() => { if (canStop && !requested) onStop() }}>{requested ? "Stop requested" : "Stop"}</button>
      <button type="button" className="agent-subagent-action is-quiet" aria-label={`Close details for ${title}`} onClick={onClose}>Close</button>
    </div>
    <span id={`${id}-stop-note`} className="agent-sr-only">{canStop ? "Asks this subagent to stop its current turn. Stopping does not undo file edits it has already made." : "Nothing is running in this subagent."}</span>
    {block && <p id={`${id}-hint`} className="agent-subagent-hint">{block}</p>}
    {requested && <p className="agent-subagent-hint" role="status">Stop requested. Waiting for the subagent to confirm; file edits it already made stay in place.</p>}
    {stopError && <p className="agent-subagent-error" role="alert">Couldn't request the stop: {stopError}</p>}
    {guide.sent && !guide.open && <p className="agent-subagent-hint" role="status">Guidance sent to this subagent.</p>}
    {guide.open && <form className="agent-subagent-guide" onSubmit={submit}>
      <label htmlFor={`${id}-guide`}>Guide this subagent</label>
      <textarea id={`${id}-guide`} data-focus-key={`${key}:field`} rows={3} maxLength={GUIDE_LIMIT} value={draft} placeholder="Tell it what to do next. It is sent as your message." aria-describedby={`${id}-count`} onChange={event => onDraft(event.target.value)} />
      <div className="agent-subagent-guide-foot">
        <span id={`${id}-count`}>{draft.length.toLocaleString("en-US")} / 4,000</span>
        <button type="button" className="agent-subagent-action is-quiet" onClick={onCancelGuide}>Cancel</button>
        <button type="submit" className="agent-subagent-action is-primary" disabled={!draft.trim() || !!block || !!guide.sending}>{guide.sending ? "Sending…" : "Send guidance"}</button>
      </div>
      {guide.error && <p className="agent-subagent-error" role="alert">{guide.error}</p>}
    </form>}
  </div>
}
