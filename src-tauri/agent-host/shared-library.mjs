// One account-private catalog. Kernel flock ownership serializes independent SSH
// processes and is released by the OS on crashes; no client owns the catalog.
import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { constants, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const object = value => !!value && typeof value === "object" && !Array.isArray(value)
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value)
const revision = value => Number.isSafeInteger(value) && value >= 0
const digest = value => createHash("sha256").update(value).digest("hex")
const stable = value => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
const fields = ["title", "pinned", "archivedAt", "order"]

function integerMilliseconds(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error("Invalid shared timestamp; the original catalog was preserved")
  return Math.trunc(value)
}

function privateJson(file, limit) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > limit) throw new Error("Unsafe or oversized private library record")
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1))
    let length = 0, count
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count
    if (length > limit || length !== info.size) throw new Error("Library record changed while reading")
    return JSON.parse(bytes.subarray(0, length).toString("utf8"))
  } finally { closeSync(fd) }
}

function checkedDirectory(directory, privateOnly = false) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & (privateOnly ? 0o077 : 0o022)) throw new Error("Unsafe remote account library directory")
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicJson(file, value, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined
    if (exclusive) linkSync(temporary, file)
    else renameSync(temporary, file)
    syncDirectory(join(file, ".."))
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

function accountIdentity(root) {
  const file = join(root, "account.json")
  try { atomicJson(file, { protocolVersion: 4, serverAccountId: randomUUID() }, true) }
  catch (error) { if (error.code !== "EEXIST") throw error }
  const account = privateJson(file, 4096)
  if (account.protocolVersion !== 4 || !/^[a-f0-9-]{36}$/.test(account.serverAccountId || "")) throw new Error("Invalid account identity")
  return account
}

/** Compatibility discovery: never attaches to or starts a provider. */
export function discoverLibrary(home, after = "", limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || after && !safeId(after)) throw new Error("Invalid remote library page")
  const root = join(home, ".local", "state", "still")
  checkedDirectory(root)
  const account = accountIdentity(root)
  const agents = join(root, "agents")
  let entries
  try {
    const info = lstatSync(agents)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o022) throw new Error("Unsafe remote execution directory")
    entries = readdirSync(agents).filter(safeId).filter(id => id > after).sort()
    if (entries.length > 8192) throw new Error("Remote execution discovery quota exceeded")
  } catch (error) { if (error.code !== "ENOENT") throw error; entries = [] }
  const page = entries.slice(0, limit), rows = [], warnings = [], legacyRecords = [], incompleteExecutions = []
  for (const executionId of page) {
    try { rows.push(workerRecord(home, executionId)) }
    catch (error) {
      const directory = join(agents, executionId)
      // Bootstrap reserves a directory and writes bundled modules before its
      // recovery checks and first committed state. Discovery must not turn an
      // unfinished/refused start (or a concurrent directory removal) into a
      // broken conversation. This is not evidence of worker death.
      if (error.code === "ENOENT" && [directory, join(directory, "state.json")].includes(error.path)) incompleteExecutions.push(executionId)
      else if (error.code === "STILL_LEGACY_METADATA") legacyRecords.push({ executionId, reason: error.message })
      else warnings.push(`Execution ${executionId}: ${error.message}`)
    }
  }
  return { ...account, rows, warnings, legacyRecords, incompleteExecutions, next: entries.length > limit ? page.at(-1) : null }
}

function workerRecord(home, executionId) {
  if (!safeId(executionId)) throw new Error("Invalid execution identity")
  const directory = join(home, ".local", "state", "still", "agents", executionId)
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error("Unsafe execution directory")
  const state = privateJson(join(directory, "state.json"), 2 * 1024 * 1024)
  if (state.executionId === executionId && [1, 2, 3].includes(state.version)
      && [state.conversationId, state.cwd, state.agentId].some(value => value === undefined)) {
    const error = new Error("Legacy worker has incomplete conversation/project/provider metadata; its original records were kept")
    error.code = "STILL_LEGACY_METADATA"
    throw error
  }
  if (state.executionId !== executionId || !safeId(state.conversationId) || typeof state.cwd !== "string" || !state.cwd.startsWith("/") || state.cwd.length > 4096 || /\p{Cc}/u.test(state.cwd) || !safeId(state.agentId)) throw new Error("Invalid conversation identity")
  return { conversationId: state.conversationId, executionId, cwd: state.cwd, agentId: state.agentId,
    agentSessionId: state.sessionResult?.sessionId || null, protocolVersion: state.version,
    parentConversationId: state.parentConversationId, available: !state.ended && !state.closed,
    closed: state.closed === true, ended: state.ended === true,
    busy: state.busy === true, activityAt: integerMilliseconds(lstatSync(join(directory, "state.json")).mtimeMs),
    prepared: state.hasAcceptedPrompt === false && !!state.parentConversationId,
    hasAcceptedPrompt: state.hasAcceptedPrompt,
    remoteCursor: revision(state.eventIndex) ? state.eventIndex : 0,
    title: typeof state.title === "string" ? [...state.title.replace(/\p{Cc}/gu, " ")].slice(0, 160).join("") : "",
    titleRecorded: typeof state.title === "string",
    titleRevision: revision(state.titleRevision) ? state.titleRevision : 0,
    replacesExecutionId: state.replacesExecutionId,
    replacesAgentSessionId: state.replacesAgentSessionId,
    titleSource: state.titleSource === "agent" ? "agent" : "prompt",
    historyCapabilities: state.historyCapabilities && typeof state.historyCapabilities === "object" && !Array.isArray(state.historyCapabilities)
      ? { revert: state.historyCapabilities.revert === true, retry: state.historyCapabilities.retry === true } : undefined,
    resumable: state.sessionResult?._meta?.resumable === true
      || state.agentId === "gemini" && state.sessionResult?._meta?.resumable === undefined
        && state.initializeResult?.agentCapabilities?.loadSession === true && !!state.sessionResult?.sessionId }
}

const validLegacyTitle = value => typeof value === "string" && !!value.trim() && [...value.trim()].length <= 80
  && Buffer.byteLength(value.trim()) <= 320 && !/\p{Cc}/u.test(value)

/** Read only title events, incrementally. Never replay a prompt or copy history
 * into the catalog. Long tool/image frames are discarded with bounded memory. */
function legacyTitle(home, incoming, previous) {
  let fd
  try { fd = openSync(join(home, ".local/state/still/agents", incoming.executionId, "events.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if (error.code === "ENOENT") return incoming; throw error }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error("Unsafe saved title journal")
    const reusable = object(previous) && previous.device === info.dev && previous.inode === info.ino
      && revision(previous.offset) && revision(previous.size) && previous.offset <= previous.size && previous.size <= info.size
      && (previous.size < info.size || previous.modifiedAt === info.mtimeMs)
      && (previous.title === "" || validLegacyTitle(previous.title)) && revision(previous.revision)
    const cache = reusable ? { ...previous } : { offset: 0, discarding: false, title: "", revision: 0 }
    let position = cache.offset, lineStart = position, discarding = cache.discarding === true, length = 0
    const end = Math.min(info.size, position + 8 * 1024 * 1024)
    const bytes = Buffer.alloc(64 * 1024), line = Buffer.alloc(4096)
    while (position < end) {
      const count = readSync(fd, bytes, 0, Math.min(bytes.length, end - position), position)
      if (!count) break
      let start = 0
      while (start < count) {
        const newline = bytes.indexOf(10, start)
        const complete = newline >= 0 && newline < count
        const stop = complete ? newline : count
        if (!discarding) {
          if (length + stop - start <= line.length) {
            bytes.copy(line, length, start, stop); length += stop - start
          } else { discarding = true; length = 0 }
        }
        if (complete) {
          if (!discarding && length) {
            const text = line.subarray(0, length).toString("utf8")
            if (text.includes('"_still/chat_title_changed"')) {
              try {
                const frame = JSON.parse(text)
                if (frame.method === "_still/chat_title_changed" && validLegacyTitle(frame.params?.title)) {
                  cache.title = frame.params.title.trim()
                  cache.revision = Math.max(cache.revision + 1, revision(frame._still?.index) ? frame._still.index : 0)
                }
              } catch { /* Invalid or interrupted title records are not evidence. */ }
            }
          }
          length = 0; discarding = false; lineStart = position + stop + 1
        }
        start = stop + (complete ? 1 : 0)
      }
      position += count
    }
    // Re-read a short partial UTF-8 frame on append; never persist its contents.
    cache.offset = !discarding && length ? lineStart : position
    cache.discarding = discarding
    Object.assign(cache, { device: info.dev, inode: info.ino, size: info.size, modifiedAt: info.mtimeMs })
    return { ...incoming, title: cache.title, titleSource: "agent", titleRevision: cache.revision, titleJournal: cache }
  } finally { closeSync(fd) }
}

function empty(account) { return { schemaVersion: 1, serverAccountId: account.serverAccountId, revision: 0, conversations: {}, projects: {}, receipts: [], receiptFloor: 0 } }

function validateState(state, account) {
  if (!object(state) || state.schemaVersion !== 1 || state.serverAccountId !== account.serverAccountId || !revision(state.revision) || !object(state.conversations) || !object(state.projects) || !Array.isArray(state.receipts) || state.receipts.length > 256 || !revision(state.receiptFloor)) throw new Error("Invalid shared catalog. The original was preserved.")
  if (Object.keys(state.conversations).length > 4096 || Object.keys(state.projects).length > 512) throw new Error("Shared catalog quota exceeded")
  if (state.outbox !== undefined && (!object(state.outbox) || Object.keys(state.outbox).length > 512)) throw new Error("Invalid notification outbox")
  for (const [id, row] of Object.entries(state.conversations)) {
    if (!safeId(id) || !object(row) || row.conversationId !== id || !safeId(row.executionId) || !safeId(row.agentId) || !object(row.values) || !object(row.fields) || !revision(row.revision) || !revision(row.readThroughSeq) || !revision(row.conversationSeq) || !revision(row.generation) || !object(row.executions)) throw new Error("Invalid shared conversation. The original was preserved.")
    for (const field of fields) if (!revision(row.fields[field])) throw new Error("Invalid shared field revision")
  }
  return state
}

function transaction(home, change) {
  const root = join(home, ".local", "state", "still")
  checkedDirectory(root)
  const directory = join(root, "catalog-v1")
  checkedDirectory(directory, true)
  const lock = openSync(join(directory, "writer.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const info = fstatSync(lock)
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error("Unsafe catalog writer lock")
    // flock operates on the inherited open-file description, so our descriptor
    // keeps the lock after the helper exits. close/crash releases it without PID guessing.
    try { execFileSync("flock", ["--exclusive", "--wait", "10", "3"], { stdio: ["ignore", "pipe", "pipe", lock] }) }
    catch { throw new Error("Could not lock the shared catalog. The server requires util-linux flock; retry if another operation is busy.") }
    const account = accountIdentity(root), file = join(directory, "state.json")
    let stored
    try { stored = validateState(privateJson(file, 32 * 1024 * 1024), account) }
    catch (error) { if (error.code !== "ENOENT") throw error; stored = empty(account) }
    const state = structuredClone(stored)
    const result = change(state)
    if (stable(state) !== stable(stored)) {
      validateState(state, account)
      if (Buffer.byteLength(JSON.stringify(state)) > 32 * 1024 * 1024) throw new Error("Shared catalog storage quota exceeded")
      atomicJson(file, state)
    }
    return result
  } finally { closeSync(lock) }
}

function register(state, incoming) {
  let row = state.conversations[incoming.conversationId]
  if (row?.deleted) return
  if (row && (row.cwd !== incoming.cwd || row.agentId !== incoming.agentId)) throw new Error("Conversation account/project/provider conflict; neither identity was replaced")
  const projectId = digest(incoming.cwd)
  if (!state.projects[projectId]) {
    if (Object.keys(state.projects).length >= 512) throw new Error("Shared project quota exceeded")
    state.revision++
    state.projects[projectId] = { id: projectId, cwd: incoming.cwd, name: "", order: Date.now(), revision: state.revision }
  }
  if (!row && incoming.hasAcceptedPrompt === false && !incoming.parentConversationId) return
  if (state.projects[projectId].deleted && incoming.hasAcceptedPrompt !== false && !row?.deleted) {
    state.projects[projectId].deleted = false; state.revision++; state.projects[projectId].revision = state.revision
  }
  if (!row) {
    if (Object.keys(state.conversations).length >= 4096) throw new Error("Shared conversation quota exceeded")
    row = { conversationId: incoming.conversationId, executionId: incoming.executionId, projectId, cwd: incoming.cwd,
      agentId: incoming.agentId, revision: 0, fields: Object.fromEntries(fields.map(field => [field, 0])),
      values: { title: incoming.title, titleSource: incoming.titleSource, pinned: false, archivedAt: null, order: incoming.activityAt },
      createdAt: incoming.activityAt, readThroughSeq: 0, conversationSeq: incoming.remoteCursor, executionOffset: 0, generation: 1, executions: {}, lastTitleRevision: incoming.titleRevision }
    state.conversations[row.conversationId] = row
  }
  const original = stable(row)
  row.executions[incoming.executionId] = { ...incoming, generation: row.executions[incoming.executionId]?.generation || row.generation }
  if (row.executionId !== incoming.executionId) {
    const previous = row.executions[row.executionId]
    if (incoming.replacesExecutionId === row.executionId && incoming.replacesAgentSessionId
        && incoming.agentSessionId === incoming.replacesAgentSessionId
        && (!previous.agentSessionId || previous.agentSessionId === incoming.replacesAgentSessionId)) {
      // This marker is written only after the worker's explicit, verified owner
      // recovery path. Ordinary enumeration never creates a replacement.
      row.executionId = incoming.executionId
      row.generation++
      row.executionOffset = row.conversationSeq
      row.executions[incoming.executionId].generation = row.generation
      row.lastTitleRevision = -1
    } else {
      // A resumed worker can be cataloged before an old title has been indexed.
      // Only its proved recovery lineage may fill that missing title.
      let ancestor = row.executions[row.executionId]?.replacesExecutionId
      const seen = new Set()
      while (ancestor && !seen.has(ancestor) && seen.size < 64) {
        if (ancestor === incoming.executionId && !row.values.title && row.values.titleSource !== "user" && incoming.title) {
          row.values.title = incoming.title; row.values.titleSource = incoming.titleSource; row.fields.title++
          break
        }
        seen.add(ancestor); ancestor = row.executions[ancestor]?.replacesExecutionId
      }
      if (stable(row) !== original) { state.revision++; row.revision = state.revision }
      return
    }
  }
  if (row.values.titleSource !== "user" && incoming.title && (!row.values.title || incoming.titleRevision > row.lastTitleRevision) && (row.values.title !== incoming.title || row.values.titleSource !== incoming.titleSource)) {
    row.values.title = incoming.title; row.values.titleSource = incoming.titleSource; row.fields.title++
  }
  row.lastTitleRevision = Math.max(row.lastTitleRevision, incoming.titleRevision)
  row.conversationSeq = Math.max(row.conversationSeq, (row.executionOffset || 0) + incoming.remoteCursor)
  row.activityAt = incoming.activityAt
  if (stable(row) !== original) { state.revision++; row.revision = state.revision }
}

function shared(state, row) {
  return { serverAccountId: state.serverAccountId, conversationId: row.conversationId, executionId: row.executionId,
    generation: row.generation, revision: row.revision, catalogRevision: state.revision, fields: row.fields,
    // Earlier catalogs inherited fractional filesystem milliseconds as order.
    // Normalize on the wire without rewriting organization or field revisions.
    values: { ...row.values, order: integerMilliseconds(row.values.order) }, readThroughSeq: row.readThroughSeq, conversationSeq: row.conversationSeq, executionOffset: row.executionOffset || 0,
    prepared: row.executions[row.executionId]?.prepared === true, projectId: row.projectId, deleted: row.deleted === true }
}

function registerWithPredecessors(home, state, incoming, seen = new Set(), warnings = []) {
  if (seen.has(incoming.executionId) || seen.size >= 64) throw new Error("Invalid or cyclic execution recovery lineage")
  seen.add(incoming.executionId)
  if (!incoming.titleRecorded) {
    const previous = state.conversations[incoming.conversationId]?.executions[incoming.executionId]?.titleJournal
    try { incoming = legacyTitle(home, incoming, previous) }
    catch { warnings.push(`Execution ${incoming.executionId}: saved title history could not be read safely; original records were kept`) }
  }
  if (incoming.replacesExecutionId && !state.conversations[incoming.conversationId]?.executions[incoming.replacesExecutionId]) {
    const previous = workerRecord(home, incoming.replacesExecutionId)
    if (previous.conversationId !== incoming.conversationId || previous.cwd !== incoming.cwd || previous.agentId !== incoming.agentId) throw new Error("Execution recovery lineage changed account/project/provider scope")
    registerWithPredecessors(home, state, previous, seen, warnings)
  }
  register(state, incoming)
}

export function recordSharedWorker(home, executionId, signal) {
  const incoming = workerRecord(home, executionId)
  return transaction(home, state => {
    registerWithPredecessors(home, state, incoming)
    const row = state.conversations[incoming.conversationId]
    if (!row) return { prepared: true }
    if (row.deleted) return { deleted: true }
    const queued = signal ? queueNotification(home, state, row, incoming, signal) : false
    return { ...shared(state, row), ...(queued ? { notificationQueued: true } : {}) }
  })
}

/** A provider rewind creates a new shared generation. Prior field/read/receipt
 * revisions must not silently apply to the new history boundary. */
export function recordSharedHistoryRevert(home, executionId, messageId, sessionId) {
  if (typeof messageId !== "string" || !messageId || messageId.length > 300 || /\p{Cc}/u.test(messageId)) throw new Error("Invalid rewind message identity")
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 300 || /\p{Cc}/u.test(sessionId)) throw new Error("Invalid rewind provider session")
  const incoming = workerRecord(home, executionId)
  if (!safeId(incoming.conversationId)) throw new Error("Invalid rewind conversation identity")
  if (incoming.agentSessionId !== sessionId) throw new Error("Rewind provider session does not match the worker")
  const operationId = `revert-${digest(stable({ executionId, messageId, sessionId }))}`
  return transaction(home, state => {
    state.receipts ||= []
    state.receiptFloor ??= 0
    const receipt = state.receipts.find(item => item.id === operationId)
    if (receipt) return structuredClone(receipt.result)
    registerWithPredecessors(home, state, incoming)
    const row = state.conversations[incoming.conversationId]
    if (!row || row.deleted || row.executionId !== executionId) return { ok: false, reason: "conversationUnavailable" }
    row.generation++
    row.executionOffset = row.conversationSeq
    row.readThroughSeq = row.conversationSeq
    row.activityAt = incoming.activityAt
    row.executions[executionId] = { ...incoming, generation: row.generation }
    state.revision++; row.revision = state.revision
    const result = { ok: true, conversationId: row.conversationId, generation: row.generation, sessionId }
    state.receipts ||= []
    state.receiptFloor ??= 0
    state.receipts.push({ id: operationId, fingerprint: digest(stable({ executionId, messageId, sessionId })), result: structuredClone(result), revision: state.revision })
    if (state.receipts.length > 256) state.receiptFloor = Math.max(state.receiptFloor, state.receipts.shift().revision)
    return result
  })
}

function relayConfiguration(home) {
  let config
  try { config = privateJson(join(home, ".local/state/still/catalog-v1/notification-relay.json"), 16 * 1024) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
  if (config.enabled !== true) return null
  const url = new URL(config.url)
  if (url.protocol !== "https:" || url.username || url.password || url.hash || typeof config.token !== "string" || config.token.length < 32 || config.token.length > 4096 || /\p{Cc}/u.test(config.token)) throw new Error("Invalid private notification-relay configuration")
  return { url: url.href, token: config.token }
}

function queueNotification(home, state, row, incoming, signal) {
  if (!relayConfiguration(home) || !revision(signal._still?.index)) return false
  row.notificationCursors ||= {}
  const index = signal._still.index
  if (index > incoming.remoteCursor) throw new Error("Notification event is outside the worker's durable cursor")
  if (index <= (row.notificationCursors[incoming.executionId] || 0)) return false
  state.outbox ||= {}
  const now = Date.now()
  for (const [key, entry] of Object.entries(state.outbox)) if (entry.expiresAt < now || entry.resolvedAt && entry.resolvedAt < now - 7 * 24 * 60 * 60 * 1000) delete state.outbox[key]
  const requestKey = digest(JSON.stringify(signal.method === "_still/request_outcome" ? signal.params?.requestId : signal.id) || "null")
  if (signal.method === "_still/turn_finished" || signal.method === "_still/request_outcome" && ["answered", "dismissed", "approved", "rejected", "cancelled"].includes(signal.params?.outcome)) {
    for (const entry of Object.values(state.outbox)) {
      if (entry.kind === "needsInput" && entry.conversationId === row.conversationId && entry.executionId === incoming.executionId
          && (signal.method === "_still/turn_finished" || entry.requestKey === requestKey)) entry.resolvedAt = now
    }
  }
  row.notificationCursors[incoming.executionId] = index
  let kind
  if (["session/request_permission", "elicitation/create"].includes(signal.method)) kind = "needsInput"
  if (signal.method === "_still/turn_finished" && signal.params?.stopReason !== "cancelled") kind = signal.params?.error ? "failure" : "result"
  if (!kind) return false
  if (Object.keys(state.outbox).length >= 512) throw new Error("Notification outbox quota exceeded; worker history remains authoritative")
  const eventId = `alert-${digest(`${incoming.executionId}:${index}`)}`
  // Opaque routing facts only: no prompt, transcript, request body, permissions,
  // attachment URLs, SSH endpoint or credentials leave this account.
  state.outbox[eventId] = { eventId, kind, serverAccountId: state.serverAccountId, conversationId: row.conversationId,
    executionId: incoming.executionId, generation: row.generation, sequence: (row.executionOffset || 0) + index,
    ...(kind === "needsInput" ? { requestKey } : {}), createdAt: now, expiresAt: now + 24 * 60 * 60 * 1000,
    attempts: 0, nextAttemptAt: now }
  state.revision++
  return true
}

/** Relay acceptance is not FCM delivery, phone receipt, or provider completion. */
export async function deliverSharedNotifications(home, send) {
  const config = relayConfiguration(home)
  if (!config) return { configured: false, accepted: 0 }
  const owner = randomUUID()
  const claimed = transaction(home, state => {
    const now = Date.now()
    const entry = Object.values(state.outbox || {}).find(item => !item.resolvedAt && !item.relayAcceptedAt && item.expiresAt > now && item.nextAttemptAt <= now && (!item.leaseUntil || item.leaseUntil <= now))
    if (!entry) return null
    entry.leaseOwner = owner; entry.leaseUntil = now + 60_000
    return structuredClone(entry)
  })
  if (!claimed) return { configured: true, accepted: 0 }
  const payload = Object.fromEntries(["eventId", "kind", "serverAccountId", "conversationId", "executionId", "generation", "sequence", "requestKey", "expiresAt"].filter(key => claimed[key] !== undefined).map(key => [key, claimed[key]]))
  let accepted = false
  try {
    if (send) accepted = await send(payload)
    else {
      const response = await fetch(config.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` }, body: JSON.stringify(payload) })
      if (!response.ok) throw new Error("Relay did not accept the event")
      const reader = response.body?.getReader(), chunks = []
      let length = 0
      if (!reader) throw new Error("Relay response had no acknowledgement")
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 16 * 1024) { await reader.cancel(); throw new Error("Relay response exceeded the acknowledgement limit") }
        chunks.push(Buffer.from(value))
      }
      accepted = JSON.parse(Buffer.concat(chunks).toString("utf8")).eventId === claimed.eventId
    }
  } catch { /* Retry state is durable; no credential or response body is logged. */ }
  transaction(home, state => {
    const current = state.outbox?.[claimed.eventId]
    if (!current || current.leaseOwner !== owner) return
    delete current.leaseOwner; delete current.leaseUntil
    current.attempts++
    if (accepted) current.relayAcceptedAt = Date.now()
    else current.nextAttemptAt = Date.now() + Math.min(15 * 60_000, 5000 * 2 ** Math.min(current.attempts - 1, 8))
  })
  return { configured: true, accepted: accepted ? 1 : 0 }
}

export function startSharedNotificationSender(home) {
  if (!relayConfiguration(home)) return
  const source = fileURLToPath(import.meta.url)
  const log = openSync(join(home, ".local/state/still/catalog-v1/notification-sender.log"), constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
  try {
    const info = fstatSync(log)
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error("Unsafe notification sender log")
    const child = spawn(process.execPath, [source, "shared-deliver"], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, HOME: home } })
    child.on("error", () => {})
    child.unref()
  } finally { closeSync(log) }
}

async function runNotificationSender(home) {
  const lock = openSync(join(home, ".local/state/still/catalog-v1/notification-sender.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const info = fstatSync(lock)
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error("Unsafe notification sender lock")
    try { execFileSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", lock] }) } catch { return }
    while (relayConfiguration(home)) {
      const result = await deliverSharedNotifications(home)
      const pending = transaction(home, state => Object.values(state.outbox || {}).some(item => !item.resolvedAt && !item.relayAcceptedAt && item.expiresAt > Date.now()))
      if (!pending) return
      if (!result.accepted) await new Promise(resolve => setTimeout(resolve, 5000))
    }
  } finally { closeSync(lock) }
}

export function setSharedChildTitle(home, conversationId, parentId, title) {
  if (!safeId(conversationId) || !safeId(parentId) || typeof title !== "string" || !title.trim() || [...title].length > 160 || /\p{Cc}/u.test(title)) throw new Error("Invalid child title")
  return transaction(home, state => {
    const row = state.conversations[conversationId]
    if (!row || row.executions[row.executionId].parentConversationId !== parentId) throw new Error("The child title belongs to another parent")
    if (row.values.titleSource === "user") return
    row.values.title = title.trim(); row.values.titleSource = "agent"; row.fields.title++
    state.revision++; row.revision = state.revision
  })
}

export function registerSharedProject(home, cwd) {
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 4096 || /\p{Cc}/u.test(cwd)) throw new Error("Invalid shared project folder")
  return transaction(home, state => {
    const id = digest(cwd)
    if (!state.projects[id] || state.projects[id].deleted) {
      if (!state.projects[id] && Object.keys(state.projects).length >= 512) throw new Error("Shared project quota exceeded")
      state.revision++
      state.projects[id] = { ...state.projects[id], id, cwd, name: state.projects[id]?.name || "", order: Date.now(), revision: state.revision, deleted: false }
    }
    return state.projects[id]
  })
}

/** Shared by human and model-created workers. A reservation remains active until
 * a newer durable worker boundary proves it idle; a missing file proves nothing. */
export function reserveSharedChildSlot(home, executionId, phase = "prepare") {
  const incoming = workerRecord(home, executionId)
  if (!incoming.parentConversationId) return
  if (!safeId(incoming.parentConversationId) || !["prepare", "dispatch", "release"].includes(phase)) throw new Error("Invalid parent/child capacity scope")
  return transaction(home, state => {
    state.childSlots ||= {}
    const slots = state.childSlots[incoming.parentConversationId] ||= {}
    for (const slot of Object.values(slots)) {
      try {
        const current = workerRecord(home, slot.executionId)
        if (current.closed || !current.available && !current.busy || current.remoteCursor > slot.afterCursor && current.hasAcceptedPrompt === true && !current.busy) slot.active = false
      } catch { /* Keep an uncertain child reserved rather than creating more work. */ }
    }
    const previous = slots[incoming.conversationId]
    if (previous && previous.executionId !== executionId && incoming.replacesExecutionId !== previous.executionId) throw new Error("A different execution owns this child capacity reservation")
    const others = Object.entries(slots).filter(([id, slot]) => id !== incoming.conversationId && slot.active).length
    if (phase !== "release" && others >= 3) throw new Error("This parent already has three active subagents. Wait for a safe turn boundary before starting more work.")
    slots[incoming.conversationId] = { executionId, active: phase !== "release", afterCursor: incoming.remoteCursor, phase }
  })
}

export function sharedLibrary(home, { after = "", limit = 100 } = {}) {
  if (after && !safeId(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid shared library page")
  return transaction(home, state => {
    let cursor = "", count = 0
    const warnings = [], legacyRecords = [], incompleteExecutions = []
    do {
      const page = discoverLibrary(home, cursor)
      for (const row of page.rows) {
        try { registerWithPredecessors(home, state, row, new Set(), warnings) } catch (error) { warnings.push(error.message) }
      }
      warnings.push(...page.warnings)
      legacyRecords.push(...page.legacyRecords)
      incompleteExecutions.push(...page.incompleteExecutions)
      cursor = page.next
      count += page.rows.length
      if (count > 4096) throw new Error("Remote execution quota exceeded")
    } while (cursor)
    const all = Object.values(state.conversations).filter(row => !row.deleted && row.conversationId > after).sort((a, b) => a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0)
    const page = all.slice(0, limit)
    return { protocolVersion: 4, catalogVersion: 1, serverAccountId: state.serverAccountId, revision: state.revision,
      projects: Object.values(state.projects), tombstones: Object.values(state.conversations).filter(row => row.deleted).map(row => row.conversationId), legacyRecords, incompleteExecutions,
      rows: page.map(row => { const { titleJournal: _index, ...execution } = row.executions[row.executionId]; const lineage = executionLineage(row); return { ...execution, ...(lineage.length ? { lineage } : {}), shared: shared(state, row) } }), warnings,
      next: all.length > limit ? page.at(-1).conversationId : null }
  })
}

/** Server-proven ancestry of the current execution, nearest ancestor first.
    Bounded at 64 hops and cycle-safe. Older workers omit the field entirely. */
export function executionLineage(row) {
  const lineage = [], seen = new Set([row.executionId])
  let child = row.executions[row.executionId]
  while (child?.replacesExecutionId && lineage.length < 64 && !seen.has(child.replacesExecutionId)) {
    const id = child.replacesExecutionId
    seen.add(id)
    lineage.push({ executionId: id, agentSessionId: row.executions[id]?.agentSessionId ?? child.replacesAgentSessionId ?? null })
    child = row.executions[id]
  }
  return lineage
}

export function mutateSharedLibrary(home, input) {
  if (!object(input) || !["organization.patch", "read.advance", "project.patch", "project.reorder", "project.delete", "conversation.delete"].includes(input.kind) || !safeId(input.operationId) || !revision(input.expectedCatalogRevision)) throw new Error("Invalid shared operation")
  return transaction(home, state => {
    if (state.serverAccountId !== input.serverAccountId) throw new Error("This operation belongs to a different remote account")
    const fingerprint = digest(stable(input))
    const receipt = state.receipts.find(receipt => receipt.id === input.operationId)
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new Error("Operation identity was already used with a different payload")
      const result = structuredClone(receipt.result)
      if (result.current) result.current.values.order = integerMilliseconds(result.current.values.order)
      return result
    }
    if (input.expectedCatalogRevision < state.receiptFloor) return { ok: false, code: "operationExpired", message: "This operation is older than the receipt retention boundary. Refresh before choosing a new operation." }
    let result
    if (input.kind === "project.delete") {
      const project = state.projects[input.projectId]
      if (!project || project.cwd !== input.cwd || project.deleted || !revision(input.expectedRevision)) throw new Error("Invalid shared project deletion")
      if (project.revision !== input.expectedRevision) return { ok: false, code: "revisionConflict", project }
      let cursor = ""
      do {
        const page = discoverLibrary(home, cursor)
        if (page.warnings.length || page.legacyRecords.length || page.incompleteExecutions.length) throw new Error("Remote execution records need recovery before shared project removal")
        for (const row of page.rows) registerWithPredecessors(home, state, row)
        cursor = page.next
      } while (cursor)
      if (Object.values(state.conversations).some(row => row.cwd === project.cwd && !row.deleted)) return { ok: false, code: "projectNotEmpty", message: "This project still contains shared conversations. Their files and history were kept.", project }
      project.deleted = true; state.revision++; project.revision = state.revision
      result = { ok: true, project }
    } else if (input.kind === "project.reorder") {
      const all = Object.values(state.projects).filter(project => !project.deleted)
      if (!Array.isArray(input.order) || input.order.length !== all.length || new Set(input.order.map(item => item?.id)).size !== all.length) throw new Error("Project ordering must include this account's exact current project set")
      for (const item of input.order) {
        if (!state.projects[item.id] || !revision(item.revision)) throw new Error("Invalid project order scope")
        if (state.projects[item.id].revision !== item.revision) return { ok: false, code: "revisionConflict", projects: all }
      }
      state.revision++
      input.order.forEach((item, index) => { state.projects[item.id].order = (all.length - index) * 1024; state.projects[item.id].revision = state.revision })
      result = { ok: true, projects: Object.values(state.projects) }
    } else if (input.kind === "project.patch") {
      const project = state.projects[input.projectId]
      if (!project || project.cwd !== input.cwd || !object(input.patch) || Object.keys(input.patch).some(key => !["name", "order"].includes(key)) || !Object.keys(input.patch).length || !revision(input.expectedRevision)) throw new Error("Invalid shared project patch")
      if (input.patch.name !== undefined && (typeof input.patch.name !== "string" || input.patch.name.length > 160 || /\p{Cc}/u.test(input.patch.name))) throw new Error("Invalid shared project name")
      if (input.patch.order !== undefined && !revision(input.patch.order)) throw new Error("Invalid shared project order")
      if (project.revision !== input.expectedRevision) return { ok: false, code: "revisionConflict", project }
      Object.assign(project, input.patch); state.revision++; project.revision = state.revision
      result = { ok: true, project }
    } else {
      const row = state.conversations[input.conversationId]
      if (!row || row.cwd !== input.cwd || row.executionId !== input.executionId || row.generation !== input.expectedGeneration) throw new Error("Shared conversation scope or execution generation changed")
      if (row.deleted) return { ok: false, code: "deleted", current: shared(state, row) }
      if (input.kind === "read.advance") {
        if (!revision(input.readThroughSeq) || input.readThroughSeq > row.conversationSeq) throw new Error("Read watermark is outside the observed conversation")
        if (input.readThroughSeq > row.readThroughSeq) { row.readThroughSeq = input.readThroughSeq; state.revision++; row.revision = state.revision }
        for (const entry of Object.values(state.outbox || {})) if (entry.conversationId === row.conversationId && entry.kind !== "needsInput" && entry.sequence <= row.readThroughSeq) entry.resolvedAt = Date.now()
      } else if (input.kind === "conversation.delete") {
        if (row.revision !== input.expectedRevision) return { ok: false, code: "revisionConflict", current: shared(state, row) }
        const worker = workerRecord(home, row.executionId)
        if (worker.available || worker.busy) throw new Error("Close this execution explicitly before shared deletion. Deleting a catalog entry never stops remote work.")
        row.deleted = true; state.revision++; row.revision = state.revision
      } else {
        if (!object(input.patch) || !Object.keys(input.patch).length || Object.keys(input.patch).some(key => !fields.includes(key)) || !object(input.expectedFields)) throw new Error("Unsupported shared metadata field; drafts and credentials stay on this device")
        for (const [key, value] of Object.entries(input.patch)) {
          if (!revision(input.expectedFields[key])) throw new Error("A revision is required for every changed field")
          if (row.fields[key] !== input.expectedFields[key]) return { ok: false, code: "revisionConflict", current: shared(state, row) }
          if (key === "title" && (typeof value !== "string" || [...value].length > 160 || Buffer.from(value).toString("utf8") !== value || /\p{Cc}/u.test(value))) throw new Error("Invalid shared conversation title")
          if (key === "pinned" && typeof value !== "boolean" || key === "archivedAt" && value !== null && !revision(value) || key === "order" && !revision(value)) throw new Error("Invalid shared metadata value")
        }
        state.revision++; row.revision = state.revision
        for (const [key, value] of Object.entries(input.patch)) { row.values[key] = value; row.fields[key]++ }
        if (Object.hasOwn(input.patch, "title")) row.values.titleSource = "user"
      }
      result = { ok: true, current: shared(state, row) }
    }
    state.receipts.push({ id: input.operationId, fingerprint, result: structuredClone(result), revision: state.revision })
    if (state.receipts.length > 256) state.receiptFloor = Math.max(state.receiptFloor, state.receipts.shift().revision)
    return result
  })
}

const invocation = process.argv[1] === "shared-call" || process.argv[2] === "shared-call"
if (process.argv[2] === "shared-deliver") await runNotificationSender(process.env.HOME)
if (invocation) {
  try {
    let bytes = Buffer.alloc(0)
    for await (const chunk of process.stdin) {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > 1024 * 1024) throw new Error("Shared library request exceeded 1 MiB")
    }
    const request = JSON.parse(bytes.toString("utf8"))
    const result = request.method === "list" ? sharedLibrary(process.env.HOME, request.options) : request.method === "mutate" ? mutateSharedLibrary(process.env.HOME, request.input) : request.method === "project.register" ? registerSharedProject(process.env.HOME, request.cwd) : request.method === "recordHistoryRevert" ? recordSharedHistoryRevert(process.env.HOME, request.executionId, request.messageId, request.sessionId) : (() => { throw new Error("Unsupported shared library request") })()
    console.log("STILL_SHARED:" + JSON.stringify(result))
  } catch (error) {
    const message = error instanceof SyntaxError ? "A private catalog or request record is invalid. The original data was preserved." : error.message
    console.log("STILL_SHARED_ERROR:" + JSON.stringify(message))
    console.error(message)
    process.exitCode = 1
  }
}
