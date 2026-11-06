// A detached, per-conversation ACP process. SSH transports attach; they do not own it.
import { createServer, createConnection } from "node:net"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, chmodSync, lstatSync, openSync, closeSync, writeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync, fstatSync } from "node:fs"
import { dirname, join } from "node:path"
import { acquireTodoOwner, createTodoStore, readTodoSeed, todoStorePath } from "./todos.mjs"
import { recoverExecutionOwner, workerBootId } from "./recovery.mjs"

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
const version = 3
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
  let initializeResult = null, sessionResult = null, busy = false, activePrompt = null, closing = false, maxRequestId = 3
  const titlePromptPath = join(directory, "chat-title-prompted")
  let initializeOperation = null, sessionOperation = null
  const todoRoot = join(process.env.HOME, ".local", "state", "still", "agent-todos")
  mkdirSync(todoRoot, { recursive: true, mode: 0o700 })
  const todoRootStat = lstatSync(todoRoot)
  if (!todoRootStat.isDirectory() || todoRootStat.isSymbolicLink() || todoRootStat.uid !== process.getuid?.()) throw new Error("Unsafe todo storage directory")
  chmodSync(todoRoot, 0o700)
  const conversation = typeof config.conversationId === "string" && config.conversationId ? config.conversationId : config.executionId
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
  const planCapable = config.agentId === "codex" || config.agentId === "gemini"
  let todoRegistered = false, todoObserved = false, planObserved = false
  let configGeneration = 0, configKey = "", capabilitiesKey = "", observedAt = Date.now()
  let runtime = { transport: transports[config.agentId] || "acp-v1", ...(config.providerRuntime || {}) }
  const pending = new Map(), inflight = new Map(), history = []
  const journal = openSync(journalPath, "a", 0o600)
  const bootId = workerBootId()
  const remember = () => {
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ version, executionId: config.executionId, conversationId: conversation, cwd: config.cwd, agentId: config.agentId, bootId, pid: process.pid, childPid: child?.pid, sequence, eventIndex, maxRequestId, busy, activePrompt, closed, ended: childEnded, initializeResult, sessionResult }), { mode: 0o600 })
    renameSync(tmp, statePath)
  }
  const publish = message => {
    const frame = { ...message, _still: { index: ++eventIndex } }
    history.push(frame)
    writeSync(journal, JSON.stringify(frame) + "\n")
    // A response boundary or approval must survive loss of the client machine.
    if (message.result || message.error || message.method === "elicitation/create" || message.method === "session/request_permission" || message.method === "_still/todos_changed" || message.method === "_still/chat_title_changed" || message.method === "_still/capabilities_changed") fsyncSync(journal)
    remember()
    const handshake = !message.method && (message.id === initializeOperation || message.id === sessionOperation)
    if (owner?.writable && (owner.replayed || handshake)) {
      if (owner.writableLength > 8 * 1024 * 1024) owner.destroy()
      else writeLine(owner, handshake ? message : frame)
    }
  }
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
    if (config.agentId !== "gemini") return
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
    publish(message)
    if (historyResult) publish({ jsonrpc:"2.0",method:"_still/history_reverted",params:historyResult })
    if (sessionReady) rememberCapabilities()
    if (settingChanged) capabilitiesDirty = true
    if (capabilitiesDirty) refreshCapabilities()
    if (sessionReady && owner) replay(owner)
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
        owner?.end()
      }
    })
    remember()
  }
  const sendToChild = frame => {
    ensureChild()
    if (!child?.stdin.writable || childEnded || closed) throw new Error("The persistent agent process has ended")
    writeLine(child.stdin, frame)
  }
  const sessionMetadata = () => {
    const capabilities = capabilityReport()
    return { ...(sessionResult?._meta || {}), persistent: true, busy, activePrompt, maxRequestId, executionId: config.executionId, todos: todoSnapshot(), ...(capabilities ? { capabilities } : {}) }
  }
  const replay = socket => {
    for (const event of history) {
      const method = event.method
      const pendingRequest = (method === "session/request_permission" || method === "elicitation/create") && pending.has(JSON.stringify(event.id))
      const response = !method && event.id !== initializeOperation && event.id !== sessionOperation
      const shouldReplay = event._still.index > socket.cursor && (method === "session/update" || method === "_still/request_outcome" || method === "_still/history_reverted" || method === "_still/todos_changed" || method === "_still/chat_title_changed" || method === "_still/capabilities_changed" || pendingRequest || response)
      if (shouldReplay) writeLine(socket,event)
    }
    // Forms are state, not disposable events: disk history intentionally strips their schema.
    for (const request of pending.values()) {
      const event = [...history].reverse().find(event => event.method === request.method && event.id === request.id)
      if (event && event._still.index <= socket.cursor) writeLine(socket,{...event,_still:{...event._still,pending:true}})
    }
    writeLine(socket,{jsonrpc:"2.0",method:"_still/caught_up",params:{index:eventIndex,...sessionMetadata()}})
    socket.replayed = true
  }
  const reject = (socket, request, message) => {
    if (request.id !== undefined) writeLine(socket, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } })
  }
  const handle = (socket, request) => {
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
      if (closed || childEnded) {
        writeLine(socket, { jsonrpc: "2.0", method: "_still/unavailable", params: { executionId: config.executionId, reason: "workerUnavailable" } })
        socket.end(); return
      }
      if (owner && owner !== socket) {
        writeLine(owner, { jsonrpc: "2.0", method: "_still/replaced" }); owner.end()
      }
      owner = socket
      const cursor = Math.max(0, Number(request.params?.after || 0))
      writeLine(socket, { jsonrpc: "2.0", method: "_still/attached", params: { version, executionId: config.executionId, index: eventIndex, initialized: !!sessionResult, busy } })
      socket.cursor = cursor; socket.replayed = false
      return
    }
    if (owner !== socket) throw new Error("Attach before sending agent messages")
    if (typeof request.id === "number" && Number.isSafeInteger(request.id)) maxRequestId = Math.max(maxRequestId, request.id)
    if (request.method === "_still/status") {
      if (childEnded || closed) {
        writeLine(socket, { jsonrpc: "2.0", method: "_still/unavailable", params: { executionId: config.executionId, reason: "workerUnavailable" } })
        socket.end(); return
      }
      writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { busy, activePrompt } })
      return
    }
    if (request.method === "_still/shutdown") {
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
    if (["session/new", "session/load"].includes(request.method)) {
      if (sessionResult) {
        writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { ...sessionResult, _meta: sessionMetadata() } })
        replay(socket)
        return
      }
      if (sessionOperation !== null) return
      sessionOperation = request.id
      if (config.agentId === "gemini") {
        request = { ...request, params: { ...request.params, mcpServers: [
          ...(request.params?.mcpServers || []),
          { name: "still-todos", command: process.execPath, args: [join(directory, "todos.mjs"), "mcp"], env: [{ name: "STILL_TODO_SOCKET", value: socketPath }, { name: "STILL_TODO_TOKEN", value: todoToken }] },
        ] } }
      }
    }
    if (!request.method && request.id !== undefined) {
      if (!pending.has(JSON.stringify(request.id))) { reject(socket, request, "This agent request has already been answered or cancelled"); return }
      const question = pending.get(JSON.stringify(request.id))
      sendToChild(request)
      pending.delete(JSON.stringify(request.id))
      const permission = question.method === "session/request_permission"
      const choice = permission ? question.params.options.find(option => option.optionId === request.result?.outcome?.optionId) : null
      publish({ jsonrpc: "2.0", method: "_still/request_outcome", params: {
        requestId: request.id, kind: permission ? "permission" : "question", title: permission ? question.params.toolCall?.title || "Permission required" : question.params.message || "Agent question",
        outcome: permission ? request.result?.outcome?.outcome === "cancelled" ? "cancelled" : choice?.kind?.startsWith("allow") ? "approved" : choice?.kind?.startsWith("reject") ? "rejected" : "uncertain" : request.result?.action === "accept" ? "answered" : request.result?.action === "cancel" ? "cancelled" : "dismissed",
        ...(choice?.name ? { responseLabel: choice.name } : {})
      } })
      return
    }
    if (request.method === "session/prompt") {
      const messageId = request.params?._meta?.messageId
      if (!messageId) throw new Error("Persistent prompts require a stable message identity")
      const receipt = join(directory, `prompt-${createHash("sha256").update(messageId).digest("hex")}.json`)
      if (existsSync(receipt)) { reject(socket, request, "This prompt was already submitted. Reattach to inspect its result."); return }
      if (busy || pending.size) { reject(socket, request, "The agent is busy or needs your answer"); return }
      writeFileSync(receipt, JSON.stringify({ id: request.id, messageId }), { mode: 0o600, flag: "wx" })
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
      for (const question of pending.values()) publish({ jsonrpc: "2.0", method: "_still/request_outcome", params: { requestId: question.id, kind: question.method === "elicitation/create" ? "question" : "permission", title: question.params?.message || question.params?.toolCall?.title || "Agent request", outcome: "cancelled" } })
      pending.clear()
    }
    if (request.id !== undefined) inflight.set(JSON.stringify(request.id), {
      method: request.method, messageId: request._meta?.messageId,
      ...(["session/set_model", "session/set_mode"].includes(request.method) ? { params: request.params } : {}),
    })
    try { sendToChild(request) } catch (error) { reject(socket, request, errors(error)) }
  }
  const server = createServer(socket => {
    clients.add(socket)
    frames(socket, request => { try { handle(socket, request) } catch (error) { writeLine(socket, { jsonrpc: "2.0", method: "_still/error", params: { message: errors(error) } }); socket.end() } }, () => socket.destroy())
    socket.on("error", () => {})
    socket.on("close", () => { clients.delete(socket); if (owner === socket) owner = null })
  })
  if (existsSync(socketPath)) unlinkSync(socketPath)
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve) })
  chmodSync(socketPath, 0o600)
  remember()
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
  let socket
  try { socket = await connect() }
  catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error
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
  writeLine(socket, { jsonrpc: "2.0", method: "_still/attach", params: { executionId: config.executionId, after: config.after || 0 } })
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(signal, () => { socket.destroy(); process.exit(0) })
}

if (mode === "worker") await worker()
else if (mode === "attach" || mode === "stop") await transport()
else throw new Error("Unknown persistent agent transport mode")
