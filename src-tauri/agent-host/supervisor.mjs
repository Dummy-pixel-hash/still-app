// A detached, per-conversation ACP process. SSH transports attach; they do not own it.
import { createServer, createConnection } from "node:net"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, chmodSync, lstatSync, openSync, closeSync, writeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync, fstatSync, constants } from "node:fs"
import { dirname, join } from "node:path"
import { acquireTodoOwner, createTodoStore, readTodoSeed, todoStorePath } from "./todos.mjs"
import { recoverExecutionOwner, workerBootId } from "./recovery.mjs"
import { pathToFileURL } from "node:url"

const mode = process.argv[2]
const encoded = process.argv[3]
const config = JSON.parse(Buffer.from(encoded || "", "base64").toString("utf8"))
if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Persistent agents require Node.js 20 or newer on the server")
if (!config.directory || !config.executionId || !Array.isArray(config.command)) throw new Error("Invalid persistent agent configuration")
const directory = config.directory
const key = createHash("sha256").update(directory).digest("hex").slice(0, 28)
// Do not use XDG_RUNTIME_DIR: logind may remove it when the SSH login ends.
const socketPath = join("/tmp", `still-${process.getuid?.() ?? "user"}-${key}.sock`)
const journalPath = join(directory, "events.jsonl")
const statePath = join(directory, "state.json")
const continuity = config.continuity === true
const version = continuity ? 4 : 3
// Provider protocol by integration. A display name never establishes this.
const transports = { opencode: "http-v2+sse", codex: "codex-app-server", claude: "claude-stream-json", pi: "pi-rpc", gemini: "acp-v1" }
const optionsKey = options => JSON.stringify((Array.isArray(options) ? options : [])
  .filter(option => typeof option?.id === "string")
  .map(option => [option.id, option.type ?? null, option.currentValue ?? null])
  .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
// Direct ACP peers can still advertise model/mode controls in the older session
// fields. Fingerprint those only when the modern catalog did not offer them.
const effectiveOptions = result => {
  const options = Array.isArray(result?.configOptions) ? [...result.configOptions] : []
  for (const [category, section, available, current] of [
    ["mode", "modes", "availableModes", "currentModeId"],
    ["model", "models", "availableModels", "currentModelId"],
  ]) {
    if (!options.some(option => option?.category === category) && Array.isArray(result?.[section]?.[available])) {
      options.push({ id: `still:${category}`, type: "select", currentValue: result[section][current] ?? "" })
    }
  }
  return options
}
const validStructuredPlan = update => Array.isArray(update?.entries) && update.entries.length <= 100
  && update.entries.every(entry => entry && typeof entry.content === "string" && entry.content.trim().length > 0
    && entry.content.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.content)
    && ["pending", "in_progress", "completed"].includes(entry.status))
const errors = error => error instanceof Error ? error.message : String(error)
const writeLine = (target, frame) => target.write(JSON.stringify(frame) + "\n")

function privateText(file, limit) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > limit) throw new Error("Unsafe or oversized private worker record")
    return readFileSync(fd, "utf8")
  } finally { closeSync(fd) }
}

function frames(read, onFrame, onError) {
  let buffer = Buffer.alloc(0)
  let discarding = false
  read.on("data", bytes => {
    buffer = Buffer.concat([buffer, Buffer.from(bytes)])
    for (;;) {
      if (discarding) {
        const end = buffer.indexOf(10)
        if (end < 0) { buffer = Buffer.alloc(0); return }
        buffer = buffer.subarray(end + 1); discarding = false
        continue
      }
      const end = buffer.indexOf(10)
      if (end < 0) {
        if (buffer.length > 16 * 1024 * 1024) {
          onError(new Error("Persistent agent frame exceeded 16 MiB and was discarded"))
          buffer = Buffer.alloc(0); discarding = true
        }
        return
      }
      const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1)
      if (!line.trim()) continue
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) { onError(new Error("Persistent agent frame exceeded 16 MiB and was discarded")); continue }
      try { onFrame(JSON.parse(line)) } catch (error) { onError(error) }
    }
  })
}

async function worker() {
  process.umask(0o077)
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
  let lock
  try { lock = openSync(join(directory, "worker.lock"), "wx", 0o600) }
  catch { throw new Error("A persistent worker already owns this conversation") }
  const executionLock = fstatSync(lock)
  process.once("exit", () => {
    try {
      const current = lstatSync(join(directory, "worker.lock"))
      if (current.isFile() && current.dev === executionLock.dev && current.ino === executionLock.ino) unlinkSync(join(directory, "worker.lock"))
    } catch { /* Do not remove a replaced or ambiguous execution lock. */ }
    try { closeSync(lock) } catch { /* Startup cleanup is best effort. */ }
  })
  const clients = new Set()
  let owner = null, child = null, childEnded = false, closed = false, sequence = 0, eventIndex = 0
  const subscribers = new Set()
  let providerRequestId = 1000
  const subagentRequests = new Map()
  let initializeResult = null, sessionResult = null, busy = false, configuring = false, rewinding = false, activePrompt = null, closing = false, maxRequestId = 3
  const titlePromptPath = join(directory, "chat-title-prompted")
  let initializeOperation = null, sessionOperation = null
  const todoRoot = join(process.env.HOME, ".local", "state", "still", "agent-todos")
  mkdirSync(todoRoot, { recursive: true, mode: 0o700 })
  const todoRootStat = lstatSync(todoRoot)
  if (!todoRootStat.isDirectory() || todoRootStat.isSymbolicLink() || todoRootStat.uid !== process.getuid?.()) throw new Error("Unsafe todo storage directory")
  chmodSync(todoRoot, 0o700)
  const conversation = typeof config.conversationId === "string" && config.conversationId ? config.conversationId : config.executionId
  const sharedLibrary = config.sharedLibrary ? await import(pathToFileURL(join(directory, "shared-library.mjs")).href) : null
  const serverSubagentsModule = config.serverSubagents ? await import(pathToFileURL(join(directory, "subagents.mjs")).href) : null
  let serverSubagents = null
  let sharedTitle = typeof config.title === "string" ? config.title : "", sharedTitleSource = config.title ? "agent" : "prompt"
  let sharedTitleRevision = 0
  let hasAcceptedPrompt = false
  const todoFile = todoStorePath(process.env.HOME, conversation)
  const todoDirectory = dirname(todoFile)
  mkdirSync(todoDirectory, { recursive: true, mode: 0o700 })
  const todoDirectoryStat = lstatSync(todoDirectory)
  if (!todoDirectoryStat.isDirectory() || todoDirectoryStat.isSymbolicLink() || todoDirectoryStat.uid !== process.getuid?.()) throw new Error("Unsafe per-conversation todo directory")
  chmodSync(todoDirectory, 0o700)
  if (Object.hasOwn(config, "todoSeed")) throw new Error("Todo seed must be delivered through the private bootstrap file")
  if (config.hasTodoSeed !== undefined && typeof config.hasTodoSeed !== "boolean") throw new Error("Invalid Todo seed marker")
  if (config.hasTodoSeed && config.create !== true) throw new Error("Todo seed is only valid for a new execution")
  const todoOwner = config.recoverFrom ? recoverExecutionOwner(directory, todoDirectory, config) : acquireTodoOwner(todoDirectory, config.executionId)
  let todoOwnerActive = true
  process.once("exit", todoOwner.release)
  const todoSeed = config.hasTodoSeed ? readTodoSeed(directory) : undefined
  const todos = createTodoStore(todoFile, todoSeed)
  if (todoSeed !== undefined) unlinkSync(join(directory, "todo-seed.json"))
  const todoToken = randomBytes(32).toString("hex")
  let todoToolAvailable = false
  const todoSnapshot = () => ({ ...todos.snapshot(), protocolVersion: 3, toolAvailable: todoOwnerActive && todoToolAvailable, available: todoOwnerActive })
  // Capability facts belong to this worker: only it sees registration, calls, plans,
  // and setting changes, and only it can state which generation they describe.
  const planCapable = config.agentId === "codex" || (transports[config.agentId] || "acp-v1") === "acp-v1"
  let todoRegistered = false, todoObserved = false, planObserved = false
  let configGeneration = 0, configKey = "", capabilitiesKey = "", observedAt = Date.now()
  let runtime = { transport: transports[config.agentId] || "acp-v1", ...(config.providerRuntime || {}) }
  const pending = new Map(), inflight = new Map(), history = []
  const journal = openSync(journalPath, "a", 0o600)
  const bootId = workerBootId()
  const remember = () => {
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ version, executionId: config.executionId, conversationId: conversation, cwd: config.cwd, agentId: config.agentId, customAgent: config.customAgent, parentConversationId: config.parentConversationId, title: sharedTitle, titleSource: sharedTitleSource, titleRevision: sharedTitleRevision, hasAcceptedPrompt, replacesExecutionId: config.recoverFrom?.executionId, replacesAgentSessionId: config.recoverFrom?.agentSessionId, bootId, pid: process.pid, childPid: child?.pid, sequence, eventIndex, maxRequestId, busy, configuring, rewinding, activePrompt, closed, ended: childEnded, historyCapabilities: historyCapabilities(), initializeResult, sessionResult }), { mode: 0o600 })
    renameSync(tmp, statePath)
  }
  const publish = message => {
    if (message.method === "_still/prompt_accepted") hasAcceptedPrompt = true
    if (message.method === "_still/chat_title_changed" && typeof message.params?.title === "string") { sharedTitle = message.params.title; sharedTitleSource = "agent"; sharedTitleRevision++ }
    if (message.method === "_still/prompt_accepted" && !sharedTitle && typeof message.params?.text === "string") { sharedTitle = [...message.params.text.split("\n")[0]].slice(0, 160).join(""); sharedTitleRevision++ }
    const frame = { ...message, _still: { index: eventIndex + 1 } }
    const bytes = Buffer.from(JSON.stringify(frame) + "\n")
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(journal, bytes, offset, bytes.length - offset)
      if (!written) throw new Error("Worker history write did not complete")
      offset += written
    }
    // A response boundary or approval must survive loss of the client machine.
    if (continuity || message.result || message.error || message.method === "elicitation/create" || message.method === "session/request_permission" || message.method === "_still/todos_changed" || message.method === "_still/chat_title_changed" || message.method === "_still/capabilities_changed" || message.method === "_still/subagents_request") fsyncSync(journal)
    eventIndex++
    history.push(frame)
    remember()
    if (sharedLibrary && ["_still/prompt_accepted", "_still/chat_title_changed", "_still/turn_finished", "session/request_permission", "elicitation/create", "_still/request_outcome"].includes(message.method)) {
      try {
        const committed = sharedLibrary.recordSharedWorker(process.env.HOME, config.executionId, frame)
        if (message.method === "_still/turn_finished" && config.parentConversationId) sharedLibrary.reserveSharedChildSlot(process.env.HOME, config.executionId, "release")
        if (committed.notificationQueued) sharedLibrary.startSharedNotificationSender(process.env.HOME)
      }
      catch (error) { process.stderr.write(`Shared catalog update needs retry: ${errors(error)}\n`) }
    }
    const handshake = !message.method && (message.id === initializeOperation || message.id === sessionOperation)
    for (const target of continuity ? subscribers : owner ? [owner] : []) {
      if (continuity && ["_still/subagents_request", "_still/subagents_reply_ack"].includes(message.method) && target !== owner) continue
      if (!target.writable || (!target.replayed && !handshake)) continue
      if (target.writableLength > 8 * 1024 * 1024) target.destroy()
      else writeLine(target, handshake ? message : frame)
    }
  }
  const syncDirectory = () => { const fd = openSync(directory, "r"); try { fsyncSync(fd) } finally { closeSync(fd) } }
  const featureReport = () => {
    const sharedTodos = !todoOwnerActive
      ? { status: "unverified", reason: "This execution no longer owns the conversation Todo list." }
      : todoObserved
      ? { status: "supported", evidence: "observed", reason: "An authenticated Still Todo request was accepted in this configuration." }
      : todoRegistered
        ? { status: "supported", evidence: "advertised", reason: "The provider acknowledged the Still Todo tool for this execution." }
        : { status: "unverified", reason: configGeneration > 0 ? "Settings changed; waiting for a new Todo tool acknowledgement or call." : "Waiting for the provider to acknowledge the Still Todo tool." }
    const providerPlans = planObserved
      ? { status: "supported", evidence: "observed", reason: "A structured provider plan was received in this configuration." }
      : planCapable
        ? { status: "unverified", reason: "Waiting for this session to report a structured plan." }
        : { status: "unsupported", evidence: "adapter", reason: "This integration does not consume structured provider plans." }
    return {
      sharedTodos,
      providerPlans,
      providerTaskProjection: { status: "unsupported", evidence: "adapter", reason: "Native provider tasks are not synchronized here." },
      clientTodoWrite: { status: "unsupported", evidence: "adapter", reason: "The agent manages task names and Done/Not done status." },
    }
  }
  const capabilityReport = () => {
    const agentSessionId = sessionResult?.sessionId
    if (!agentSessionId) return null
    return { schemaVersion: 1, executionId: config.executionId, agentSessionId, cwd: config.cwd, configGeneration, observedAt, providerRuntime: runtime, features: featureReport() }
  }
  const capabilitiesSignature = report => JSON.stringify({ ...report, observedAt: undefined })
  const rememberCapabilities = () => { const report = capabilityReport(); if (report) capabilitiesKey = capabilitiesSignature(report) }
  const refreshCapabilities = () => {
    const report = capabilityReport()
    if (!report) return
    const signature = capabilitiesSignature(report)
    if (signature === capabilitiesKey) return
    capabilitiesKey = signature
    publish({ jsonrpc: "2.0", method: "_still/capabilities_changed", params: { capabilities: report } })
  }
  const retireTodoOwner = () => {
    if (!todoOwnerActive) return
    todoOwnerActive = false
    if (serverSubagents) void serverSubagents.close()
    todoToolAvailable = false
    todoRegistered = false
    todoObserved = false
    observedAt = Date.now()
    try {
      publish({ jsonrpc: "2.0", method: "_still/todos_changed", params: { todos: todoSnapshot() } })
      refreshCapabilities()
    } finally { todoOwner.release() }
  }
  // A duplicate notification and its response acknowledgement describe one setting
  // change; only a different effective configuration starts a new generation.
  const noteConfig = options => {
    const next = optionsKey(options)
    if (!configKey) { configKey = next; return false }
    if (next === configKey) return false
    configKey = next; configGeneration++; todoObserved = false; planObserved = false; observedAt = Date.now()
    return true
  }
  const noteLegacyMode = value => {
    if (!sessionResult || typeof value !== "string") return false
    const option = sessionResult.configOptions?.find(option => option?.id === "still:mode")
    if (option) option.currentValue = value
    else if (sessionResult.modes && typeof sessionResult.modes === "object") sessionResult.modes.currentModeId = value
    else return false
    return noteConfig(effectiveOptions(sessionResult))
  }
  const applyInitializeRuntime = result => {
    // Only a direct ACP provider reports its own version here. The wrapper's
    // "native" label is never a provider version.
    if (runtime.transport !== "acp-v1") return
    const reported = result?.agentInfo?.version
    if (typeof reported !== "string") return
    const version = [...reported.replace(/\p{Cc}/gu, " ").trim()].slice(0, 200).join("")
    if (!version || version === "native") return
    runtime = { ...runtime, version, versionSource: "runtime", versionObservedAt: Date.now() }
  }
  const stamp = message => {
    let historyResult = null
    let sessionReady = false
    let capabilitiesDirty = false
    let settingChanged = false
    const responseRecord = message.id !== undefined && !message.method ? inflight.get(JSON.stringify(message.id)) : undefined
    const providerUpdate = message.method === "session/update" && sessionResult
      && message.params?.sessionId === sessionResult.sessionId ? message.params.update : null
    if (providerUpdate?.sessionUpdate === "config_option_update" && Array.isArray(providerUpdate.configOptions)) {
      sessionResult.configOptions = providerUpdate.configOptions
      settingChanged = noteConfig(effectiveOptions(sessionResult))
    }
    if (providerUpdate?.sessionUpdate === "current_mode_update") {
      settingChanged = noteLegacyMode(providerUpdate.currentModeId) || settingChanged
    }
    if (planCapable && providerUpdate?.sessionUpdate === "plan" && validStructuredPlan(providerUpdate)) {
      planObserved = true; observedAt = Date.now(); capabilitiesDirty = true
    }
    if (message.id !== undefined && message.method) pending.set(JSON.stringify(message.id), message)
    if (message.id !== undefined && !message.method) {
      const record = inflight.get(JSON.stringify(message.id))
      if (record?.method === "initialize" && message.result) { initializeResult = message.result; applyInitializeRuntime(message.result) }
      if (["session/new", "session/load"].includes(record?.method) && message.result) {
        sessionResult = message.result
        runtime = { ...runtime, ...(message.result._meta?.providerRuntime || {}) }
        configKey = optionsKey(effectiveOptions(message.result))
        message = { ...message, result: { ...message.result, _meta: sessionMetadata() } }
        sessionReady = true
      }
      if (record?.method === "session/set_config_option" && Array.isArray(message.result?.configOptions) && sessionResult) {
        sessionResult.configOptions = message.result.configOptions
        settingChanged = noteConfig(effectiveOptions(sessionResult)) || settingChanged
      }
      if (record?.method === "session/set_mode" && message.result && sessionResult) {
        settingChanged = noteLegacyMode(record.params?.modeId) || settingChanged
      }
      if (record?.method === "session/set_model" && message.result && sessionResult && typeof record.params?.modelId === "string") {
        const option = sessionResult.configOptions?.find(option => option?.id === "still:model")
        if (option) option.currentValue = record.params.modelId
        else if (sessionResult.models && typeof sessionResult.models === "object") sessionResult.models.currentModelId = record.params.modelId
        settingChanged = noteConfig(effectiveOptions(sessionResult)) || settingChanged
      }
      if (record?.method === "session/prompt") { busy = false; activePrompt = null }
      if (record?.method === "_still/session/revert") rewinding = false
      if (record?.method === "_still/session/revert" && message.result?.reverted === true && message.result?.sessionId && sessionResult) {
        if (Array.isArray(message.result.configOptions)) {
          sessionResult.configOptions = message.result.configOptions
          settingChanged = noteConfig(effectiveOptions(sessionResult)) || settingChanged
        }
        if (sessionResult.sessionId !== message.result.sessionId) {
          planObserved = false
          todoObserved = false
          observedAt = Date.now()
          capabilitiesDirty = true
        }
        sessionResult.sessionId = message.result.sessionId
        if (record.messageId) historyResult = { messageId: record.messageId, sessionId: message.result.sessionId }
      }
      inflight.delete(JSON.stringify(message.id))
    }
    if (continuity && responseRecord?.configurationBatch) {
      if (settingChanged && sessionResult) publish({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sessionResult.sessionId, update: { sessionUpdate: "config_option_update", configOptions: sessionResult.configOptions || [] } } })
      if (message.error) responseRecord.configurationBatch.reject(new Error(message.error.message || "Provider rejected the setting."))
      else responseRecord.configurationBatch.resolve()
    } else if (continuity && responseRecord?.socket) {
      if (responseRecord.method === "session/prompt") {
        publish({ jsonrpc: "2.0", method: "_still/turn_finished", params: { promptId: message.id, stopReason: message.result?.stopReason, error: message.error?.message } })
      } else {
        if (settingChanged && sessionResult) publish({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sessionResult.sessionId, update: { sessionUpdate: "config_option_update", configOptions: sessionResult.configOptions || [] } } })
        if (settingChanged) publish({ jsonrpc: "2.0", method: "_still/config_generation", params: { configGeneration } })
        if (responseRecord.socket.writable) writeLine(responseRecord.socket, { ...message, id: responseRecord.clientId })
      }
    } else publish(message)
    if (historyResult) {
      publish({ jsonrpc:"2.0",method:"_still/history_reverted",params:historyResult })
      if (sharedLibrary) {
        try { sharedLibrary.recordSharedHistoryRevert(process.env.HOME, config.executionId, historyResult.messageId, historyResult.sessionId) }
        catch (error) { process.stderr.write(`Shared catalog history update needs retry: ${errors(error)}\n`) }
      }
    }
    if (sessionReady) rememberCapabilities()
    if (settingChanged) capabilitiesDirty = true
    if (capabilitiesDirty) refreshCapabilities()
    if (continuity && settingChanged && !responseRecord?.socket) publish({ jsonrpc: "2.0", method: "_still/config_generation", params: { configGeneration } })
    if (sessionReady) for (const target of continuity ? subscribers : owner ? [owner] : []) replay(target)
  }
  const failure = message => publish({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sessionResult?.sessionId, update: { sessionUpdate: "session_error", message } } })
  const ensureChild = () => {
    if (child || childEnded || closed) return
    const [executable, ...args] = config.command
    try {
      child = spawn(executable, args, { cwd: config.cwd, env: { ...process.env, ...(config.env || {}), STILL_TODO_SOCKET: socketPath, STILL_TODO_TOKEN: todoToken, STILL_TODO_MODULE: join(directory, "todos.mjs"), STILL_TODO_PI_EXTENSION: join(directory, "todo-pi.mjs") }, stdio: ["pipe", "pipe", "pipe"] })
    } catch (error) {
      childEnded = true; retireTodoOwner(); throw error
    }
    frames(child.stdout, stamp, error => { failure(`Agent returned invalid protocol: ${errors(error)}`); child.kill("SIGTERM") })
    child.stderr.on("data", bytes => process.stderr.write(bytes))
    child.stdin.on("error", error => { if (!closing) failure(`Agent input stream closed: ${errors(error)}`) })
    child.on("error", error => {
      // A failed spawn has no PID. An error from a live child's kill/send path is
      // not evidence of exit and must not release conversation ownership.
      if (!child.pid) { childEnded = true; retireTodoOwner() }
      failure(`Agent process error: ${errors(error)}`)
    })
    child.on("exit", (code, signal) => {
      childEnded = true; busy = false; retireTodoOwner(); remember()
      if (!closing) {
        failure(`Remote agent process exited (${signal || code}). Its saved conversation remains available.`)
        publish({ jsonrpc: "2.0", method: "_still/unavailable", params: { executionId: config.executionId, reason: "workerUnavailable" } })
        for (const target of continuity ? subscribers : owner ? [owner] : []) target.end()
      }
    })
    remember()
  }
  const sendToChild = frame => {
    ensureChild()
    if (!child?.stdin.writable || childEnded || closed) throw new Error("The persistent agent process has ended")
    writeLine(child.stdin, frame)
  }
  const historyCapabilities = () => sessionResult?._meta?.historyCapabilities && typeof sessionResult._meta.historyCapabilities === "object" && !Array.isArray(sessionResult._meta.historyCapabilities)
    ? { revert: sessionResult._meta.historyCapabilities.revert === true, retry: sessionResult._meta.historyCapabilities.retry === true } : { revert: false, retry: false }
  const sessionMetadata = () => {
    const capabilities = capabilityReport()
    return { ...(sessionResult?._meta || {}), persistent: true, continuity, configGeneration, busy, configuring, rewinding, activePrompt, maxRequestId, executionId: config.executionId, todos: todoSnapshot(), historyCapabilities: historyCapabilities(), ...(capabilities ? { capabilities } : {}) }
  }
  const replay = socket => {
    for (const event of history) {
      const method = event.method
      // Request creation is part of history even after another device answers.
      // Replay its ordered outcome too, so a fresh client can understand the turn.
      const pendingRequest = method === "session/request_permission" || method === "elicitation/create"
      const response = !method && event.id !== initializeOperation && event.id !== sessionOperation
      const shouldReplay = event._still.index > socket.cursor && (method === "session/update" || method === "_still/prompt_accepted" || method === "_still/turn_finished" || method === "_still/config_generation" || method === "_still/request_outcome" || method === "_still/history_reverted" || method === "_still/todos_changed" || method === "_still/chat_title_changed" || method === "_still/capabilities_changed" || (!continuity || owner === socket) && (method === "_still/subagents_request" || method === "_still/subagents_reply_ack") || pendingRequest || response)
      if (shouldReplay) writeLine(socket,event)
    }
    // Forms are state, not disposable events: disk history intentionally strips their schema.
    for (const request of pending.values()) {
      const event = [...history].reverse().find(event => event.method === request.method && event.id === request.id)
      if (event && event._still.index <= socket.cursor) writeLine(socket,{...event,_still:{...event._still,pending:true}})
    }
    for (const [id, subagent] of subagentRequests) {
      const event = [...history].reverse().find(event => event.method === "_still/subagents_request" && String(event.id) === id)
      if ((!continuity || owner === socket) && event && event._still.index <= socket.cursor) writeLine(socket, { ...event, _still: { ...event._still, pending: true } })
    }
    writeLine(socket,{jsonrpc:"2.0",method:"_still/caught_up",params:{index:eventIndex,ended:childEnded || closed,...sessionMetadata()}})
    socket.replayed = true
  }
  const reject = (socket, request, message) => {
    if (request.id !== undefined) writeLine(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } })
  }
  const subagentInputError = input => {
    if (!input || typeof input !== "object" || Array.isArray(input) || !["list", "prepare", "spawn", "inspect", "guide", "wait", "cancel"].includes(input.action)) return "Choose a supported subagent action."
    if (input.action === "prepare" && (typeof input.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.agentId) || input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || [...input.title].length > 160))) return "Prepare requires an eligible agent ID and an optional title of 1–160 characters."
    if (input.action === "spawn" && (input.childId === undefined && (typeof input.agentId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.agentId)) || typeof input.title !== "string" || !input.title.trim() || [...input.title].length > 160 || typeof input.task !== "string" || !input.task.trim() || [...input.task].length > 12000)) return "Spawn requires a prepared child ID or eligible agent ID, a title of 1–160 characters, and a task of 1–12,000 characters."
    if (input.action === "spawn" && input.childId !== undefined && (typeof input.childId !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.childId))) return "Spawn child ID is invalid."
    if (input.modelId !== undefined && (typeof input.modelId !== "string" || !input.modelId.trim() || [...input.modelId].length > 300)) return "Model ID must be 1–300 characters."
    if (input.effort !== undefined && (typeof input.effort !== "string" || !input.effort.trim() || [...input.effort].length > 100)) return "Effort must be 1–100 characters."
    if (input.modeId !== undefined && (typeof input.modeId !== "string" || !input.modeId.trim() || [...input.modeId].length > 100)) return "Mode ID must be 1–100 characters."
    if (["inspect", "guide", "wait", "cancel"].includes(input.action) && (typeof input.childId !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.childId))) return `${input.action} requires a valid child ID.`
    if (input.action === "guide" && (typeof input.message !== "string" || !input.message.trim() || [...input.message].length > 4000)) return "Guide requires a message of 1–4,000 characters."
    if (input.action === "wait" && input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 15000)) return "Wait timeout must be from 1,000 to 15,000 milliseconds."
    return null
  }
  const requestSubagents = (socket, request) => {
    const token = request.params?.token
    const authenticated = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(todoToken))
    if (!authenticated) { reject(socket, request, "Only the registered Still subagent tool may access child conversations."); return }
    if (closed || childEnded || !todoOwnerActive) { reject(socket, request, "This parent execution no longer owns child coordination."); return }
    if (!serverSubagents && (!owner?.writable || !owner.replayed)) { reject(socket, request, "The parent conversation is not attached. Reconnect before managing subagents."); return }
    if (config.parentConversationId) { reject(socket, request, "Subagents cannot create or manage nested subagents."); return }
    const input = request.params?.input
    const invalid = subagentInputError(input)
    if (invalid) { reject(socket, request, invalid); return }
    const requestKey = String(request.id)
    if (serverSubagents) {
      void serverSubagents.apply(input, requestKey).then(result => {
        if (socket.writable) writeLine(socket, { jsonrpc: "2.0", id: request.id, result })
      }).catch(error => reject(socket, request, errors(error)))
      return
    }
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(requestKey) || subagentRequests.has(requestKey)) { reject(socket, request, "Invalid or duplicate subagent request ID."); return }
    subagentRequests.set(requestKey, { socket, requestId: request.id })
    publish({ jsonrpc: "2.0", id: request.id, method: "_still/subagents_request", params: { requestId: request.id, input } })
    socket.once("close", () => { if (subagentRequests.get(requestKey)?.socket === socket) subagentRequests.delete(requestKey) })
  }
  const configureAndPrompt = async (socket, request) => {
    const fail = (message, configurationFailure = false) => {
      if (socket.writable) writeLine(socket, { jsonrpc: "2.0", id: request.id, error: { code: configurationFailure ? -32030 : -32000, message, ...(configurationFailure ? { data: { configurationFailure: true } } : {}) } })
    }
    const params = request.params || {}, meta = params._meta || {}
    if (!continuity || !sessionResult) { fail("Send settings with a prompt only to an initialized continuity worker."); return }
    if (params.sessionId !== sessionResult.sessionId) { fail("This settings batch belongs to a different provider session."); return }
    if (configuring || busy || pending.size || inflight.size) { fail("The conversation is busy; settings were not applied and no prompt was sent."); return }
    if (meta.expectedConfigGeneration !== configGeneration) { fail("Settings changed on another device. Refresh them before sending; no prompt was sent."); return }
    const messageId = meta.messageId, source = meta.source || "user", prompt = params.prompt
    if (typeof messageId !== "string" || !messageId || messageId.length > 300 || /\p{Cc}/u.test(messageId)
      || !["user", "parentAgent"].includes(source) || !Array.isArray(prompt) || !prompt.length
      || prompt.some(part => !part || part.type !== "text" || typeof part.text !== "string")
      || !prompt.some(part => part.text.trim()) || Buffer.byteLength(JSON.stringify(prompt)) > 121000) {
      fail("Invalid shared prompt or stable message identity; no prompt was sent."); return
    }
    const receipt = join(directory, `prompt-${createHash("sha256").update(messageId).digest("hex")}.json`)
    const signature = createHash("sha256").update(JSON.stringify({ prompt, source, configGeneration: meta.expectedConfigGeneration })).digest("hex")
    if (existsSync(receipt)) {
      try {
        const previous = JSON.parse(readFileSync(receipt, "utf8"))
        const accepted = history.some(event => event.method === "_still/prompt_accepted" && event.params.messageId === messageId)
        if (previous.signature === signature && accepted) writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { accepted: true, messageId, promptId: previous.id } })
        else fail("This prompt identity was already used or its delivery is uncertain. Inspect the conversation before retrying.")
      } catch { fail("The prompt receipt is unsafe or unreadable. No prompt was resent.") }
      return
    }
    const rawSettings = params.settings
    if (!Array.isArray(rawSettings) || rawSettings.length > 16) { fail("Choose at most 16 settings before sending."); return }
    const ids = new Set()
    const settings = []
    for (const item of rawSettings) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.configId !== "string" || !/^[^\p{Cc}]{1,160}$/u.test(item.configId)
        || ids.has(item.configId) || !(typeof item.value === "boolean" || typeof item.value === "string" && item.value.length <= 4096 && !/\p{Cc}/u.test(item.value))) {
        fail("A staged setting is invalid or duplicated. Refresh the settings and try again."); return
      }
      ids.add(item.configId); settings.push({ configId: item.configId, value: item.value })
    }
    const options = () => effectiveOptions(sessionResult)
    const optionFor = id => options().find(option => option?.id === id)
    const category = id => optionFor(id)?.category || (id === "still:model" ? "model" : id === "still:mode" ? "mode" : "")
    const order = id => category(id) === "model" ? 0
      : ["thought_level", "reasoning", "effort", "variant", "variants"].includes(category(id)) ? 1
        : ["mode", "agent", "agent_mode"].includes(category(id)) ? 2 : 3
    settings.sort((a, b) => order(a.configId) - order(b.configId))
    const currentValue = id => {
      const option = optionFor(id)
      if (option) return option.currentValue
      if (id === "still:model") return sessionResult.models?.currentModelId
      if (id === "still:mode") return sessionResult.modes?.currentModeId
      return undefined
    }
    const offered = (id, value) => {
      const option = optionFor(id)
      if (option?.type === "boolean") return typeof value === "boolean"
      const choices = (option?.options || []).flatMap(item => Array.isArray(item?.options) ? item.options : [item])
      if (choices.some(choice => choice?.value === value)) return true
      const legacy = id === "still:model" ? sessionResult.models?.availableModels : id === "still:mode" ? sessionResult.modes?.availableModes : null
      const key = id === "still:model" ? "modelId" : "id"
      return Array.isArray(legacy) && legacy.some(item => item?.[key] === value)
    }
    const name = id => optionFor(id)?.name || id
    configuring = true; remember()
    try {
      for (const setting of settings) {
        if (!offered(setting.configId, setting.value)) throw new Error(`${name(setting.configId)} no longer offers that choice. Refresh settings; no prompt was sent.`)
        if (currentValue(setting.configId) === setting.value) continue
        const method = setting.configId === "still:model" ? "session/set_model" : setting.configId === "still:mode" ? "session/set_mode" : "session/set_config_option"
        const settingParams = method === "session/set_model" ? { sessionId: sessionResult.sessionId, modelId: setting.value }
          : method === "session/set_mode" ? { sessionId: sessionResult.sessionId, modeId: setting.value }
            : { sessionId: sessionResult.sessionId, configId: setting.configId, value: setting.value }
        const choices = (optionFor(setting.configId)?.options || []).flatMap(item => Array.isArray(item?.options) ? item.options : [item])
        if (method === "session/set_config_option" && !optionFor(setting.configId)) throw new Error(`${name(setting.configId)} is no longer available. Refresh settings; no prompt was sent.`)
        if (method === "session/set_config_option" && !optionFor(setting.configId)?.type?.includes("boolean") && !choices.length && typeof setting.value !== "boolean") throw new Error(`${name(setting.configId)} has no current choices. Refresh settings; no prompt was sent.`)
        await new Promise((resolve, reject) => {
          const providerId = ++providerRequestId
          const key = JSON.stringify(providerId)
          const batch = { resolve, reject }
          inflight.set(key, { method, params: settingParams, configurationBatch: batch })
          try { sendToChild({ jsonrpc: "2.0", id: providerId, method, params: settingParams }) }
          catch (error) { inflight.delete(key); reject(error) }
        }).catch(error => { throw new Error(`Could not apply ${name(setting.configId)}: ${errors(error)}. No prompt was sent.`) })
        if (currentValue(setting.configId) !== setting.value) throw new Error(`The provider did not confirm ${name(setting.configId)}. No prompt was sent.`)
      }
      // A later model/mode change can reset an earlier dependent setting.
      // Verify the full requested combination immediately before submission.
      for (const setting of settings) {
        if (!offered(setting.configId, setting.value) || currentValue(setting.configId) !== setting.value) {
          throw new Error(`${name(setting.configId)} changed while applying settings. Review the available choices; no prompt was sent.`)
        }
      }
      if (!socket.writable) throw new Error("The connection closed while settings were being applied. No prompt was sent; reconnect and review the selected settings.")
      // Drop the lock and forward the prompt synchronously in the same JS turn;
      // another device cannot interleave between final setting confirmation and send.
      configuring = false
      remember()
      handle(socket, { ...request, method: "session/prompt", params: { sessionId: sessionResult.sessionId, prompt, _meta: { messageId, source, expectedConfigGeneration: configGeneration } } })
    } catch (error) {
      configuring = false; remember()
      fail(errors(error), true)
    }
  }
  const handle = (socket, request) => {
    if (request.method === "_still/subagents") { requestSubagents(socket, request); return }
    if (request.method === "_still/chat_title") {
      const token = request.params?.token
      const fromTool = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(todoToken))
      if (closed || childEnded || !todoOwnerActive) { reject(socket, request, "This execution no longer owns the conversation."); return }
      if (!fromTool) { reject(socket, request, "Only the registered agent title tool may rename this conversation."); return }
      const title = request.params?.input?.title
      if (typeof title !== "string" || !title.trim() || [...title.trim()].length > 80 || Buffer.byteLength(title.trim()) > 320 || /[\r\n\p{Cc}]/u.test(title.trim())) {
        reject(socket, request, "Use a chat title of 1–80 characters on one line."); return
      }
      const value = title.trim()
      publish({ jsonrpc: "2.0", method: "_still/chat_title_changed", params: { title: value } })
      writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { title: value } })
      return
    }
    if (request.method === "_still/todos" || request.method === "_still/todo_tool_ready") {
      const token = request.params?.token
      const fromTool = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(todoToken))
      if (closed || childEnded || !todoOwnerActive) { reject(socket, request, "This execution no longer owns the conversation Todo list. Restore or start the current execution before editing Todos."); return }
      if (!fromTool) { reject(socket, request, "Only the registered agent todo tool may access this list."); return }
      if (typeof request.id === "number" && Number.isSafeInteger(request.id)) maxRequestId = Math.max(maxRequestId, request.id)
      remember()
      try {
        const before = todos.snapshot().revision
        const beforeAvailable = todoToolAvailable
        if (request.method === "_still/todo_tool_ready") {
          if (!fromTool) throw new Error("Only the registered tool can acknowledge availability.")
          todoRegistered = true; observedAt = Date.now()
          if (!todoToolAvailable) {
            todoToolAvailable = true
            publish({ jsonrpc: "2.0", method: "_still/todos_changed", params: { todos: todoSnapshot() } })
          }
        } else {
          // A successful authenticated request is the only proof that the model's
          // tool actually reached this worker in this configuration.
          todos.apply(request.params?.input, "agent", request.params?.requestId)
          todoToolAvailable = true; todoRegistered = true; todoObserved = true; observedAt = Date.now()
          if (todos.snapshot().revision !== before || !beforeAvailable) publish({ jsonrpc: "2.0", method: "_still/todos_changed", params: { todos: todoSnapshot() } })
        }
        writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { todos: todoSnapshot() } })
        refreshCapabilities()
      } catch (error) { reject(socket, request, errors(error)) }
      return
    }
    if (request.method === "_still/attach") {
      if (request.params?.executionId !== config.executionId) throw new Error("Persistent execution identity mismatch")
      if (continuity && request.params?.protocolVersion !== 4) {
        writeLine(socket, { jsonrpc: "2.0", method: "_still/error", params: { message: "This shared worker requires a continuity-capable Still client. The other clients were not disconnected." } })
        socket.end(); return
      }
      if ((closed || childEnded) && !continuity) {
        writeLine(socket, { jsonrpc: "2.0", method: "_still/unavailable", params: { executionId: config.executionId, reason: "workerUnavailable" } })
        socket.end(); return
      }
      if (!continuity && owner && owner !== socket) {
        writeLine(owner, { jsonrpc: "2.0", method: "_still/replaced" }); owner.end()
      }
      if (continuity) subscribers.add(socket)
      if (!continuity || !owner) owner = socket
      const cursor = request.params?.after ?? 0
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > eventIndex) { reject(socket, request, "Replay cursor is outside this execution's history"); socket.end(); return }
      writeLine(socket, { jsonrpc: "2.0", method: "_still/attached", params: { version, executionId: config.executionId, index: eventIndex, initialized: !!sessionResult, busy } })
      socket.cursor = cursor; socket.replayed = false
      return
    }
    if (continuity ? !subscribers.has(socket) : owner !== socket) throw new Error("Attach before sending agent messages")
    if (continuity && !socket.replayed && !["initialize", "session/new", "session/load", "_still/shutdown"].includes(request.method)) { reject(socket, request, "Catch up before sending agent messages"); return }
    if (continuity && sessionResult && ["session/prompt", "session/cancel", "session/set_config_option", "session/set_mode", "session/set_model", "_still/session/revert"].includes(request.method)
      && request.params?.sessionId !== sessionResult.sessionId) { reject(socket, request, "This command belongs to a different provider session"); return }
    if (continuity && (closed || childEnded) && !["initialize", "session/new", "session/load", "_still/shutdown"].includes(request.method)) { reject(socket, request, "The provider has ended; its shared history is read-only"); return }
    if (continuity && request.method && !["initialize", "session/new", "session/load", "session/prompt", "_still/configure_and_prompt", "session/cancel", "session/set_config_option", "session/set_mode", "session/set_model", "_still/session/revert", "_still/status", "_still/prompt_receipt", "_still/shutdown"].includes(request.method)) {
      reject(socket, request, "This shared-session operation is not supported"); return
    }
    if (typeof request.id === "number" && Number.isSafeInteger(request.id)) maxRequestId = Math.max(maxRequestId, request.id)
    if (request.method === "_still/status") {
      if (childEnded || closed) {
        writeLine(socket, { jsonrpc: "2.0", method: "_still/unavailable", params: { executionId: config.executionId, reason: "workerUnavailable" } })
        socket.end(); return
      }
      writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { busy, configuring, rewinding, activePrompt, ...(continuity ? { configGeneration } : {}) } })
      return
    }
    if (continuity && request.method === "_still/prompt_receipt") {
      const messageId = request.params?.messageId
      if (typeof messageId !== "string" || !messageId || messageId.length > 300) { reject(socket, request, "Invalid prompt receipt identity"); return }
      const receipt = join(directory, `prompt-${createHash("sha256").update(messageId).digest("hex")}.json`)
      const accepted = history.find(event => event.method === "_still/prompt_accepted" && event.params.messageId === messageId)
      writeLine(socket, { jsonrpc: "2.0", id: request.id, result: {
        messageId, status: accepted ? "accepted" : existsSync(receipt) ? "unknown" : "notAccepted", index: eventIndex, busy, activePrompt,
      } })
      return
    }
    if (request.method === "_still/shutdown") {
      if (continuity && (busy || configuring || rewinding || pending.size || inflight.size)) { reject(socket, request, "The conversation is busy; shutdown was not accepted"); return }
      closing = true; closed = true; remember()
      const done = () => { writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { closed: true } }); socket.end(); for (const client of clients) if (client !== socket) client.end(); server.close() }
      if (!child || childEnded) { retireTodoOwner(); done(); return }
      child.once("exit", done)
      child.stdin.end()
      const timer = setTimeout(() => child.kill("SIGTERM"), 7000); timer.unref()
      return
    }
    if (request.method === "initialize") {
      if (initializeResult) { writeLine(socket, { jsonrpc: "2.0", id: request.id, result: initializeResult }); return }
      if (initializeOperation !== null) return
      initializeOperation = request.id
    }
    if (request.method === "_still/configure_and_prompt") { void configureAndPrompt(socket, request); return }
    if (["session/new", "session/load"].includes(request.method)) {
      if (sessionResult) {
        writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { ...sessionResult, _meta: sessionMetadata() } })
        replay(socket)
        return
      }
      if (sessionOperation !== null) return
      sessionOperation = request.id
      if (runtime.transport === "acp-v1") {
        request = { ...request, params: { ...request.params, mcpServers: [
          ...(request.params?.mcpServers || []),
          { name: "still-todos", command: process.execPath, args: [join(directory, "todos.mjs"), "mcp"], env: [{ name: "STILL_TODO_SOCKET", value: socketPath }, { name: "STILL_TODO_TOKEN", value: todoToken }] },
        ] } }
      }
    }
    if (!request.method && request.id !== undefined) {
      const subagent = subagentRequests.get(String(request.id))
      if (subagent && owner === socket) {
        subagentRequests.delete(String(request.id))
        if (request.error) writeLine(subagent.socket, { jsonrpc: "2.0", id: subagent.requestId, error: request.error })
        else writeLine(subagent.socket, { jsonrpc: "2.0", id: subagent.requestId, result: request.result })
        publish({ jsonrpc: "2.0", method: "_still/subagents_reply_ack", params: { requestId: subagent.requestId } })
        return
      }
      if (!pending.has(JSON.stringify(request.id))) { reject(socket, request, "This agent request has already been answered or cancelled"); return }
      const question = pending.get(JSON.stringify(request.id))
      const requestEvent = [...history].reverse().find(event => event.method === question.method && event.id === question.id)
      if (continuity && request._meta?.expectedRequestIndex !== requestEvent?._still.index) { reject(socket, request, "This answer belongs to an older request. Refresh before responding."); return }
      const permission = question.method === "session/request_permission"
      const choice = permission ? question.params.options?.find(option => option.optionId === request.result?.outcome?.optionId) : null
      if (permission && request.result?.outcome?.outcome !== "cancelled" && !choice) { reject(socket, request, "Choose a permission option supplied by the provider"); return }
      if (continuity) {
        const receipt = join(directory, `answer-${createHash("sha256").update(JSON.stringify([request.id, requestEvent?._still.index])).digest("hex")}.json`)
        if (existsSync(receipt)) { reject(socket, request, "Response delivery is uncertain. Inspect the current request before retrying."); return }
        const fd = openSync(receipt, "wx", 0o600)
        try { writeFileSync(fd, JSON.stringify({ requestId: request.id, status: "dispatching" })); fsyncSync(fd) } finally { closeSync(fd) }
        syncDirectory()
      }
      sendToChild(request)
      pending.delete(JSON.stringify(request.id))
      publish({ jsonrpc: "2.0", method: "_still/request_outcome", params: {
        requestId: request.id, kind: permission ? "permission" : "question", title: permission ? question.params.toolCall?.title || "Permission required" : question.params.message || "Agent question",
        outcome: permission ? request.result?.outcome?.outcome === "cancelled" ? "cancelled" : choice?.kind?.startsWith("allow") ? "approved" : choice?.kind?.startsWith("reject") ? "rejected" : "uncertain" : request.result?.action === "accept" ? "answered" : request.result?.action === "cancel" ? "cancelled" : "dismissed",
        ...(choice?.name ? { responseLabel: choice.name } : {}),
        ...(continuity && typeof request._meta?.operationId === "string" ? { operationId: request._meta.operationId } : {})
      } })
      return
    }
    if (request.method === "session/prompt") {
      const messageId = request.params?._meta?.messageId
      if (typeof messageId !== "string" || !messageId || messageId.length > 300 || /\p{Cc}/u.test(messageId)) { reject(socket, request, "Persistent prompts require a valid stable message identity"); return }
      const receipt = join(directory, `prompt-${createHash("sha256").update(messageId).digest("hex")}.json`)
      const originalPrompt = request.params.prompt
      const source = request.params?._meta?.source || "user"
      const signature = createHash("sha256").update(JSON.stringify({ prompt: originalPrompt, source, configGeneration: request.params?._meta?.expectedConfigGeneration })).digest("hex")
      if (existsSync(receipt)) {
        const previous = JSON.parse(readFileSync(receipt, "utf8"))
        if (continuity && previous.signature === signature) {
          const accepted = history.find(event => event.method === "_still/prompt_accepted" && event.params.messageId === messageId)
          if (!accepted) { reject(socket, request, "Prompt delivery is uncertain. Its receipt exists but acceptance history is incomplete."); return }
          writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { accepted: true, messageId, promptId: previous.id } }); return
        }
        reject(socket, request, "This prompt was already submitted. Reattach to inspect its result."); return
      }
      if (busy || configuring || pending.size || continuity && inflight.size) { reject(socket, request, "The agent is busy or needs your answer"); return }
      if (continuity && request.params?._meta?.expectedConfigGeneration !== configGeneration) { reject(socket, request, "Settings changed. Refresh before sending your draft."); return }
      if (continuity && (!Array.isArray(originalPrompt) || originalPrompt.some(part => !part || part.type !== "text" || typeof part.text !== "string") || !originalPrompt.some(part => part.text.trim()) || Buffer.byteLength(JSON.stringify(originalPrompt)) > 121000 || !["user", "parentAgent"].includes(source))) { reject(socket, request, "Invalid shared prompt"); return }
      if (sharedLibrary && config.parentConversationId) {
        try { sharedLibrary.reserveSharedChildSlot(process.env.HOME, config.executionId, "dispatch") }
        catch (error) { reject(socket, request, errors(error)); return }
      }
      const clientId = request.id
      if (continuity) request = { ...request, id: ++providerRequestId }
      const fd = openSync(receipt, "wx", 0o600)
      try { writeFileSync(fd, JSON.stringify({ id: request.id, messageId, signature, status: "accepted" })); fsyncSync(fd) } finally { closeSync(fd) }
      syncDirectory()
      if (continuity) {
        busy = true; activePrompt = request.id
        publish({ jsonrpc: "2.0", method: "_still/prompt_accepted", params: { messageId, source, text: originalPrompt.map(part => part.text).join("\n"), promptId: request.id } })
        writeLine(socket, { jsonrpc: "2.0", id: clientId, result: { accepted: true, messageId, promptId: request.id } })
        inflight.set(JSON.stringify(request.id), { method: request.method, socket, clientId })
      }
      if (config.agentId && !existsSync(titlePromptPath)) {
        let titlePrompted = false
        try { const fd = openSync(titlePromptPath, "wx", 0o600); fsyncSync(fd); closeSync(fd); titlePrompted = true }
        catch (error) { if (error.code !== "EEXIST") throw error }
        if (titlePrompted) {
          const text = request.params?.prompt?.map(part => part?.text || "").join("\n") || ""
          request = { ...request, params: { ...request.params, prompt: [{ type: "text", text: `[Still conversation title] Choose a concise 3–7-word title for this conversation that describes the user's request. Call still_set_chat_title with that title. Do not show the title in your response. Then handle the user's request normally.\n\n${text}` }] } }
        }
      }
      busy = true; activePrompt = request.id; remember()
    }
    if (request.method === "session/cancel") {
      if (continuity && (!busy || request.params?._meta?.promptId !== activePrompt)) { reject(socket, request, "This turn already finished; cancellation was not sent"); return }
      for (const question of pending.values()) publish({ jsonrpc: "2.0", method: "_still/request_outcome", params: { requestId: question.id, kind: question.method === "elicitation/create" ? "question" : "permission", title: question.params?.message || question.params?.toolCall?.title || "Agent request", outcome: "cancelled" } })
      pending.clear()
      if (continuity) {
        sendToChild({ ...request, id: undefined })
        publish({ jsonrpc: "2.0", method: "_still/cancel_requested", params: { promptId: activePrompt } })
        if (request.id !== undefined) writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { cancellationRequested: true } })
        return
      }
    }
    if (continuity && request.method === "_still/session/revert") {
      if (busy || configuring || rewinding || pending.size || inflight.size) { reject(socket, request, "The conversation is busy; wait before changing shared history"); return }
      if (request.params?._meta?.expectedConfigGeneration !== configGeneration) { reject(socket, request, "Settings changed on another device. Refresh before changing history."); return }
      const checkpoint = request.params?.checkpoint
      if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || !Object.keys(checkpoint).length) { reject(socket, request, "This message has no current provider checkpoint"); return }
      const clientId = request.id
      rewinding = true; remember()
      request = { ...request, id: ++providerRequestId }
      inflight.set(JSON.stringify(request.id), { method: request.method, socket, clientId, messageId: request.params?._meta?.messageId, params: request.params })
    } else if (continuity && ["session/set_config_option", "session/set_mode", "session/set_model"].includes(request.method)) {
      if (busy || configuring || rewinding || pending.size || inflight.size) { reject(socket, request, "The conversation is busy"); return }
      if (request.params?._meta?.expectedConfigGeneration !== configGeneration) { reject(socket, request, "Settings changed. Refresh before changing them."); return }
      if (request.method === "session/set_config_option") {
        const option = (sessionResult.configOptions || []).find(option => option.id === request.params?.configId)
        const choices = (option?.options || []).flatMap(item => Array.isArray(item.options) ? item.options : [item])
        const offered = option?.type === "boolean" ? typeof request.params?.value === "boolean" : choices.some(choice => choice.value === request.params?.value)
        if (!offered) { reject(socket, request, "Choose a setting value offered by the provider"); return }
      }
      const clientId = request.id
      request = { ...request, id: ++providerRequestId }
      inflight.set(JSON.stringify(request.id), { method: request.method, socket, clientId, messageId: request._meta?.messageId, params: request.params })
    }
    if (request.id !== undefined && !inflight.has(JSON.stringify(request.id))) inflight.set(JSON.stringify(request.id), {
      method: request.method, messageId: request._meta?.messageId,
      ...(["session/set_model", "session/set_mode"].includes(request.method) ? { params: request.params } : {}),
    })
    try { sendToChild(request) } catch (error) {
      const record = inflight.get(JSON.stringify(request.id))
      inflight.delete(JSON.stringify(request.id))
      if (continuity && record?.method === "session/prompt") {
        busy = false; activePrompt = null
        publish({ jsonrpc: "2.0", method: "_still/turn_finished", params: { promptId: request.id, error: `Provider delivery failed: ${errors(error)}` } })
      } else {
        if (record?.method === "_still/session/revert") { rewinding = false; remember() }
        reject(socket, { ...request, id: record?.clientId ?? request.id }, errors(error))
      }
    }
  }
  const server = createServer(socket => {
    clients.add(socket)
    frames(socket, request => { try { handle(socket, request) } catch (error) { writeLine(socket, { jsonrpc: "2.0", method: "_still/error", params: { message: errors(error) } }); socket.end() } }, () => socket.destroy())
    socket.on("error", () => {})
    socket.on("close", () => { clients.delete(socket); subscribers.delete(socket); if (owner === socket) owner = continuity ? [...subscribers][0] || null : null })
  })
  if (existsSync(socketPath)) unlinkSync(socketPath)
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve) })
  chmodSync(socketPath, 0o600)
  remember()
  if (sharedLibrary && config.parentConversationId) sharedLibrary.reserveSharedChildSlot(process.env.HOME, config.executionId, "prepare")
  if (serverSubagentsModule) {
    serverSubagents = serverSubagentsModule.createServerSubagents(config, () => todoOwnerActive)
    process.once("exit", () => serverSubagents.close())
  }
  process.on("SIGHUP", () => {})
  process.on("exit", () => { try { closeSync(journal) } catch {} try { unlinkSync(socketPath) } catch {} })
  return server
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once("error", reject)
    socket.once("connect", () => { socket.removeListener("error", reject); resolve(socket) })
  })
}

async function transport() {
  if (config.requireContinuity && existsSync(statePath)) {
    const state = JSON.parse(privateText(statePath, 16 * 1024 * 1024))
    if (state.version < 4) { writeLine(process.stdout, { jsonrpc: "2.0", method: "_still/upgrade_required", params: { executionId: config.executionId } }); return }
  }
  let socket
  try { socket = await connect() }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error
    if (!config.create && config.requireContinuity && existsSync(statePath)) {
      // The provider/worker may have ended. Its private disk journal is still
      // shared history; replay it without resurrecting the process.
      const state = JSON.parse(privateText(statePath, 16 * 1024 * 1024))
      if (state.version >= 4 && state.executionId === config.executionId && state.initializeResult && state.sessionResult) {
        const bytes = privateText(journalPath, 32 * 1024 * 1024)
        // An interrupted final append is not a complete event. Never read it as
        // accepted work or modify the original recovery evidence here.
        const history = bytes.slice(0, bytes.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line))
        writeLine(process.stdout, { jsonrpc: "2.0", method: "_still/continuity", params: { version: 4 } })
        frames(process.stdin, request => {
          if (request.method === "initialize") writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: state.initializeResult })
          else if (["session/new", "session/load"].includes(request.method)) {
            writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, result: { ...state.sessionResult, _meta: { ...state.sessionResult._meta, persistent: true, continuity: true, busy: false } } })
            for (const frame of history) if (frame._still?.index > (config.after || 0) && ["session/update", "_still/prompt_accepted", "_still/turn_finished", "_still/config_generation", "_still/request_outcome", "_still/chat_title_changed", "_still/todos_changed"].includes(frame.method)) writeLine(process.stdout, frame)
            writeLine(process.stdout, { jsonrpc: "2.0", method: "_still/caught_up", params: { index: state.eventIndex, busy: false, ended: true, activePrompt: null } })
          } else writeLine(process.stdout, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "This execution has ended; shared history is read-only" } })
        }, error => { console.error(errors(error)); process.exitCode = 1 })
        process.stdin.on("end", () => process.stdin.pause())
        return
      }
    }
    if (!config.create || existsSync(statePath)) {
      writeLine(process.stdout, { jsonrpc: "2.0", method: "_still/unavailable", params: { executionId: config.executionId, reason: "workerUnavailable" } })
      process.exitCode = 1; return
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Persistent agent directory has unsafe ownership")
    chmodSync(directory, 0o700)
    const log = openSync(join(directory, "worker.log"), "a", 0o600)
    const child = spawn(process.execPath, [process.argv[1], "worker", encoded], { detached: true, stdio: ["ignore", log, log] })
    child.unref(); closeSync(log)
    let lastError
    for (let retry = 0; retry < 80; retry++) {
      try { socket = await connect(); break } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    if (!socket) throw lastError || new Error("Persistent agent startup timed out")
  }
  let attached = false, stopping = mode === "stop"
  frames(socket, frame => {
    if (frame.method === "_still/attached") {
      attached = true
      if (stopping) writeLine(socket, { jsonrpc: "2.0", id: "close", method: "_still/shutdown" })
      else {
        if (frame.params.version >= 4) writeLine(process.stdout, { jsonrpc: "2.0", method: "_still/continuity", params: { version: frame.params.version } })
        process.stdin.pipe(socket, { end: false })
        process.stdin.on("end", () => socket.end())
      }
      return
    }
    if (frame.method === "_still/replaced") { console.error("Attached from another Still window"); socket.end(); return }
    if (frame.method === "_still/error") { console.error(frame.params?.message); process.exitCode = 1; socket.end(); return }
    writeLine(process.stdout, frame)
  }, error => { console.error(errors(error)); process.exitCode = 1; socket.destroy() })
  socket.on("error", error => { console.error(errors(error)); process.exitCode = 1 })
  socket.on("close", () => { if (!attached) process.exitCode = 1; process.stdin.unpipe(socket); process.stdin.pause() })
   writeLine(socket, { jsonrpc: "2.0", method: "_still/attach", params: { executionId: config.executionId, after: config.after || 0, protocolVersion: config.continuity ? 4 : 3 } })
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, () => { socket.destroy(); process.exit(0) })
}

if (mode === "worker") await worker()
else if (mode === "attach" || mode === "stop") await transport()
else throw new Error("Unknown persistent agent transport mode")
