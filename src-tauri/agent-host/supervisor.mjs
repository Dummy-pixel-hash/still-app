// A detached, per-conversation ACP process. SSH transports attach; they do not own it.
import { createServer, createConnection } from "node:net"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, chmodSync, lstatSync, openSync, closeSync, writeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync } from "node:fs"
import { dirname, join } from "node:path"
import { createTodoStore, todoStorePath } from "./todos.mjs"

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
const errors = error => error instanceof Error ? error.message : String(error)
const writeLine = (target, frame) => target.write(JSON.stringify(frame) + "\n")

function frames(read, onFrame, onError) {
  let buffer = Buffer.alloc(0)
  read.on("data", bytes => {
    buffer = Buffer.concat([buffer, Buffer.from(bytes)])
    if (buffer.length > 4 * 1024 * 1024) { onError(new Error("Persistent agent frame exceeds 4 MiB")); buffer = Buffer.alloc(0); return }
    let end
    while ((end = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1)
      if (!line.trim()) continue
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
  const clients = new Set()
  let owner = null, child = null, childEnded = false, closed = false, sequence = 0, eventIndex = 0
  let initializeResult = null, sessionResult = null, busy = false, activePrompt = null, closing = false, maxRequestId = 3
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
  const todos = createTodoStore(todoFile)
  const todoToken = randomBytes(32).toString("hex")
  let todoToolAvailable = false
  const todoSnapshot = () => ({ ...todos.snapshot(), protocolVersion: 3, toolAvailable: todoToolAvailable, available: true })
  const pending = new Map(), inflight = new Map(), history = []
  const journal = openSync(journalPath, "a", 0o600)
  const remember = () => {
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ version, executionId: config.executionId, pid: process.pid, childPid: child?.pid, sequence, eventIndex, maxRequestId, busy, activePrompt, closed, ended: childEnded, initializeResult, sessionResult }), { mode: 0o600 })
    renameSync(tmp, statePath)
  }
  const publish = message => {
    const frame = { ...message, _still: { index: ++eventIndex } }
    history.push(frame)
    writeSync(journal, JSON.stringify(frame) + "\n")
    // A response boundary or approval must survive loss of the client machine.
    if (message.result || message.error || message.method === "elicitation/create" || message.method === "session/request_permission" || message.method === "_still/todos_changed") fsyncSync(journal)
    remember()
    const handshake = !message.method && (message.id === initializeOperation || message.id === sessionOperation)
    if (owner?.writable && (owner.replayed || handshake)) {
      if (owner.writableLength > 8 * 1024 * 1024) owner.destroy()
      else writeLine(owner, handshake ? message : frame)
    }
  }
  const stamp = message => {
    let historyResult = null
    let sessionReady = false
    if (message.method === "session/update" && message.params?.update?.sessionUpdate === "config_option_update" && sessionResult) sessionResult.configOptions = message.params.update.configOptions
    if (message.id !== undefined && message.method) pending.set(JSON.stringify(message.id), message)
    if (message.id !== undefined && !message.method) {
      const record = inflight.get(JSON.stringify(message.id))
      if (record?.method === "initialize" && message.result) initializeResult = message.result
      if (["session/new", "session/load"].includes(record?.method) && message.result) {
        sessionResult = message.result
        message = { ...message, result: { ...message.result, _meta: sessionMetadata() } }
        sessionReady = true
      }
      if (record?.method === "session/set_config_option" && message.result?.configOptions && sessionResult) sessionResult.configOptions = message.result.configOptions
      if (record?.method === "session/prompt") { busy = false; activePrompt = null }
      if (record?.method === "_still/session/revert" && message.result?.reverted === true && message.result?.sessionId && sessionResult) {
        sessionResult.sessionId = message.result.sessionId
        if (record.messageId) historyResult = { messageId: record.messageId, sessionId: message.result.sessionId }
      }
      inflight.delete(JSON.stringify(message.id))
    }
    publish(message)
    if (historyResult) publish({ jsonrpc:"2.0",method:"_still/history_reverted",params:historyResult })
    if (sessionReady && owner) replay(owner)
  }
  const failure = message => publish({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sessionResult?.sessionId, update: { sessionUpdate: "session_error", message } } })
  const ensureChild = () => {
    if (child || childEnded || closed) return
    const [executable, ...args] = config.command
    child = spawn(executable, args, { cwd: config.cwd, env: { ...process.env, ...(config.env || {}), STILL_TODO_SOCKET: socketPath, STILL_TODO_TOKEN: todoToken, STILL_TODO_MODULE: join(directory, "todos.mjs"), STILL_TODO_PI_EXTENSION: join(directory, "todo-pi.mjs") }, stdio: ["pipe", "pipe", "pipe"] })
    frames(child.stdout, stamp, error => { failure(`Agent returned invalid protocol: ${errors(error)}`); child.kill("SIGTERM") })
    child.stderr.on("data", bytes => process.stderr.write(bytes))
    child.stdin.on("error", error => { if (!closing) failure(`Agent input stream closed: ${errors(error)}`) })
    child.on("error", error => { childEnded = true; failure(`Could not start agent: ${errors(error)}`) })
    child.on("exit", (code, signal) => {
      childEnded = true; busy = false; remember()
      if (!closing) failure(`Remote agent process exited (${signal || code}). Its saved conversation remains available.`)
    })
    remember()
  }
  const sendToChild = frame => {
    ensureChild()
    if (!child?.stdin.writable || childEnded || closed) throw new Error("The persistent agent process has ended")
    writeLine(child.stdin, frame)
  }
  const sessionMetadata = () => ({ ...(sessionResult?._meta || {}), persistent: true, busy, activePrompt, maxRequestId, executionId: config.executionId, todos: todoSnapshot() })
  const replay = socket => {
    for (const event of history) {
      const method = event.method
      const pendingRequest = (method === "session/request_permission" || method === "elicitation/create") && pending.has(JSON.stringify(event.id))
      const response = !method && event.id !== initializeOperation && event.id !== sessionOperation
      const shouldReplay = event._still.index > socket.cursor && (method === "session/update" || method === "_still/request_outcome" || method === "_still/history_reverted" || method === "_still/todos_changed" || pendingRequest || response)
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
    if (request.method === "_still/todos" || request.method === "_still/todo_tool_ready") {
      const token = request.params?.token
      const fromTool = typeof token === "string" && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(todoToken))
      if (closed || childEnded) { reject(socket, request, "The agent worker has ended. Restore the conversation before editing todos."); return }
      if (!fromTool) { reject(socket, request, "Only the registered agent todo tool may access this list."); return }
      if (typeof request.id === "number" && Number.isSafeInteger(request.id)) maxRequestId = Math.max(maxRequestId, request.id)
      remember()
      try {
        const before = todos.snapshot().revision
        if (request.method === "_still/todo_tool_ready") {
          if (!fromTool) throw new Error("Only the registered tool can acknowledge availability.")
          if (!todoToolAvailable) {
            todoToolAvailable = true
            publish({ jsonrpc: "2.0", method: "_still/todos_changed", params: { todos: todoSnapshot() } })
          }
        } else {
          todos.apply(request.params?.input, "agent", request.params?.requestId)
          if (todos.snapshot().revision !== before) publish({ jsonrpc: "2.0", method: "_still/todos_changed", params: { todos: todoSnapshot() } })
        }
        writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { todos: todoSnapshot() } })
      } catch (error) { reject(socket, request, errors(error)) }
      return
    }
    if (request.method === "_still/attach") {
      if (request.params?.executionId !== config.executionId) throw new Error("Persistent execution identity mismatch")
      if (closed || childEnded) throw new Error("The remote agent process has ended. Resume its provider session explicitly.")
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
    if (request.method === "_still/shutdown") {
      closing = true; closed = true; remember()
      const done = () => { writeLine(socket, { jsonrpc: "2.0", id: request.id, result: { closed: true } }); socket.end(); for (const client of clients) if (client !== socket) client.end(); server.close() }
      if (!child || childEnded) { done(); return }
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
      busy = true; activePrompt = request.id; remember()
    }
    if (request.method === "session/cancel") {
      for (const question of pending.values()) publish({ jsonrpc: "2.0", method: "_still/request_outcome", params: { requestId: question.id, kind: question.method === "elicitation/create" ? "question" : "permission", title: question.params?.message || question.params?.toolCall?.title || "Agent request", outcome: "cancelled" } })
      pending.clear()
    }
    if (request.id !== undefined) inflight.set(JSON.stringify(request.id), { method: request.method, messageId: request._meta?.messageId })
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
  process.on("exit", () => { closeSync(journal); closeSync(lock); try { unlinkSync(join(directory, "worker.lock")); unlinkSync(socketPath) } catch {} })
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
  catch {
    if (!config.create || existsSync(statePath)) throw new Error("Persistent worker is not available. The remote server may have restarted; its saved provider session can be resumed.")
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
