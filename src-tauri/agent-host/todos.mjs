// One worker owns the list. UI requests, MCP, and Pi all use this same mutation path.
import { openSync, closeSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync, fstatSync, lstatSync, constants } from "node:fs"
import { createConnection } from "node:net"
import { createHash, randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const statuses = ["pending", "completed"]
const actors = ["user", "agent"]
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/
const maxItems = 100
const object = value => !!value && typeof value === "object" && !Array.isArray(value)
const titleOf = title => {
  if (typeof title !== "string" || !title.trim() || [...title].length > 500 || Buffer.byteLength(title) > 2000 || /\p{Cc}/u.test(title)) throw new Error("Use a todo title of 1–500 characters on one line.")
  return title.trim()
}
const revisionOf = value => Number.isSafeInteger(value) && value >= 0

export const todoTool = {
  name: "still_todos",
  description: "Sole writer for this conversation's checklist. Read it first, add model-authored task names, focus the task you are currently working on and optionally provide a short progress detail, and mark tasks pending or completed as work changes. Use stable item IDs and the expectedRevision returned by list for every mutation; on conflict, list again and reconcile. You may rename, reorder, or remove stale tasks. Never claim that checklist completion means the turn or tests succeeded.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "add", "update", "remove", "move", "focus"] },
      expectedRevision: { type: "integer", minimum: 0, description: "Required for mutations; revision returned by list." },
      id: { type: "string", description: "Existing todo ID for update/remove/move." },
      title: { type: "string", minLength: 1, maxLength: 500, description: "Title for add or update." },
      status: { type: "string", enum: statuses },
      beforeId: { type: ["string", "null"], description: "For move: place before this ID; null moves to the end." },
      detail: { type: "string", minLength: 1, maxLength: 500, description: "Short current progress detail for a focused pending task." },
    },
  },
}

export function todoStorePath(home, conversationId) {
  if (typeof home !== "string" || !home || typeof conversationId !== "string" || !conversationId || conversationId.length > 512) throw new Error("Invalid todo storage identity.")
  return join(home, ".local", "state", "still", "agent-todos", createHash("sha256").update(conversationId).digest("hex"), "todos.json")
}

function readPrivateTodoJson(file, limit, label) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > limit) throw new Error(`Unsafe or oversized ${label}.`)
    // Bound the read too: a file can grow between fstat and read.
    const bytes = Buffer.alloc(limit + 1)
    let length = 0, count
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count
    if (length > limit) throw new Error(`Unsafe or oversized ${label}.`)
    return JSON.parse(bytes.subarray(0, length).toString("utf8"))
  } finally { closeSync(fd) }
}

function describeTodoOwner(lockFile) {
  try {
    const owner = readPrivateTodoJson(lockFile, 1024, "Todo owner lock")
    if (typeof owner.executionId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(owner.executionId) && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      return `Conversation Todos are owned by execution ${owner.executionId} (PID ${owner.pid}). Attach to that execution or perform explicit owner recovery.`
    }
  } catch { /* An unreadable or malformed owner is deliberately not reaped. */ }
  return "Conversation Todo ownership is ambiguous or unsafe. Inspect the existing owner lock; Still will not remove it automatically."
}

/** Exclusive conversation-level write ownership; stale locks require explicit recovery. */
export function acquireTodoOwner(directory, executionId, pid = process.pid) {
  if (typeof directory !== "string" || !directory || typeof executionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(executionId) || !Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Invalid conversation Todo owner identity.")
  }
  const lockFile = join(directory, "owner.lock")
  let fd
  let ownStat
  let ownsFile = false
  let initialized = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (!ownsFile) return
    try { ownStat = ownStat || fstatSync(fd) } catch { /* Leave an ambiguous lock for explicit recovery. */ }
    try { closeSync(fd) } catch { /* Closing an already closed descriptor is harmless here. */ }
    if (!ownStat) return
    try {
      const current = lstatSync(lockFile)
      if (!current.isSymbolicLink() && current.isFile() && current.uid === process.getuid?.() && current.dev === ownStat.dev && current.ino === ownStat.ino) {
        if (!initialized) { unlinkSync(lockFile); return }
        const owner = readPrivateTodoJson(lockFile, 1024, "Todo owner lock")
        if (owner.executionId === executionId && owner.pid === pid) unlinkSync(lockFile)
      }
    } catch { /* Leave an ambiguous path for explicit recovery. */ }
  }
  try {
    fd = openSync(lockFile, "wx", 0o600)
    ownsFile = true
    ownStat = fstatSync(fd)
    writeFileSync(fd, JSON.stringify({ executionId, pid }))
    fsyncSync(fd)
    initialized = true
  } catch (error) {
    try { release() } catch { /* Preserve the original startup error. */ }
    if (error.code === "EEXIST") throw new Error(describeTodoOwner(lockFile))
    throw error
  }
  return { lockFile, release }
}

export function validateTodoState(value) {
  if (!object(value) || !revisionOf(value.revision) || !Array.isArray(value.items) || value.items.length > maxItems) throw new Error("Invalid saved todo list.")
  const ids = new Set()
  const items = value.items.map(item => {
    if (!object(item) || typeof item.id !== "string" || !idPattern.test(item.id) || ids.has(item.id) || !statuses.includes(item.status) || !actors.includes(item.createdBy) || !actors.includes(item.updatedBy)) throw new Error("Invalid or duplicate saved todo.")
    ids.add(item.id)
    if (item.detail !== undefined && (typeof item.detail !== "string" || [...item.detail].length > 500 || Buffer.byteLength(item.detail) > 2000 || /\p{Cc}/u.test(item.detail))) throw new Error("Invalid todo progress detail.")
    for (const time of ["createdAt", "startedAt", "completedAt", "durationMs"]) if (item[time] !== undefined && !revisionOf(item[time])) throw new Error("Invalid todo timestamp.")
    return { id: item.id, title: titleOf(item.title), status: item.status, createdBy: item.createdBy, updatedBy: item.updatedBy,
      ...(item.createdAt !== undefined ? { createdAt:item.createdAt } : {}), ...(item.startedAt !== undefined ? { startedAt:item.startedAt } : {}),
      ...(item.completedAt !== undefined ? { completedAt:item.completedAt } : {}), ...(item.durationMs !== undefined ? { durationMs:item.durationMs } : {}),
      ...(item.detail !== undefined ? { detail:item.detail } : {}) }
  })
  const activeId=value.activeId
  if (activeId !== undefined && (typeof activeId !== "string" || !items.some(item=>item.id===activeId && item.status==="pending"))) throw new Error("Invalid active todo.")
  return { revision: value.revision, items, ...(activeId ? { activeId } : {}) }
}

export function createTodoStore(file, seed) {
  let stored
  let missing = false
  const seedState = seed === undefined ? undefined : validateTodoState(seed)
  try {
    stored = readPrivateTodoJson(file, 1024 * 1024, "todo storage file")
  } catch (error) { if (error.code !== "ENOENT") throw error; missing = true; stored = seedState || { revision: 0, items: [] } }
  let state = validateTodoState(stored)
  if (!missing && seedState && (seedState.revision > state.revision || seedState.revision === state.revision && JSON.stringify(seedState) !== JSON.stringify(state))) {
    throw new Error("Saved and remote Todo lists conflict. Inspect both before continuing; neither list was overwritten.")
  }
  let receipts = Array.isArray(stored.receipts) ? stored.receipts.slice(-256).filter(receipt => object(receipt) && typeof receipt.id === "string" && typeof receipt.input === "string") : []
  const snapshot = () => validateTodoState(state)
  const persist = (next, nextReceipts) => {
    const temporary = `${file}.${randomUUID()}.tmp`
    let fd
    try {
      fd = openSync(temporary, "wx", 0o600)
      writeFileSync(fd, JSON.stringify({ ...next, receipts: nextReceipts }))
      fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, file)
      // Rename committed the new state; a subsequent directory fsync failure must
      // not leave an old in-memory list able to overwrite that committed result.
      state = next; receipts = nextReceipts
      const directory = openSync(dirname(file), "r")
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
    }
  }
  if (missing) persist(state, receipts)
  return {
    snapshot,
    apply(input, actor, requestId) {
      if (!object(input) || actor !== "agent") throw new Error("Only the agent tool can update this conversation's Todos.")
      const allowed = {
        list: ["action"], add: ["action", "expectedRevision", "title", "status"],
        update: ["action", "expectedRevision", "id", "title", "status"],
        remove: ["action", "expectedRevision", "id"], move: ["action", "expectedRevision", "id", "beforeId"],
        focus: ["action", "expectedRevision", "id", "detail"],
      }
      if (!Object.hasOwn(allowed, input.action) || Object.keys(input).some(key => !allowed[input.action].includes(key))) throw new Error("Unsupported todo action or fields.")
      if (input.action === "list") return snapshot()
      if (typeof requestId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(requestId)) throw new Error("A stable todo request ID is required.")
      const fingerprint = JSON.stringify([actor, Object.keys(input).sort().map(key => [key, input[key]])])
      const receipt = receipts.find(receipt => receipt.id === requestId)
      if (receipt) {
        if (receipt.input !== fingerprint) throw new Error("This todo request ID was already used for another change.")
        return snapshot()
      }
      if (!revisionOf(input.expectedRevision) || input.expectedRevision !== state.revision) throw new Error("The todo list changed. Refresh it and retry your change.")
      if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error("Todo revision limit reached.")
      // Build the whole candidate before writing: a failed persistence attempt must
      // leave the committed list (including the focused task) exactly as it was.
      const items = structuredClone(state.items)
      let activeId = state.activeId
      if (input.status !== undefined && !statuses.includes(input.status)) throw new Error("Choose a supported todo status.")
      if (input.action === "add") {
        if (items.length >= maxItems) throw new Error("This conversation already has 100 todos.")
        const now=Date.now(), item={ id: randomUUID(), title: titleOf(input.title), status: input.status || "pending", createdBy: actor, updatedBy: actor, createdAt:now }
        if (item.status === "pending" && !activeId) { item.startedAt=now; activeId=item.id }
        items.push(item)
      } else {
        const index = items.findIndex(item => item.id === input.id)
        if (index < 0) throw new Error("This todo no longer exists. Refresh the list.")
        if (input.action === "focus") {
          if (items[index].status !== "pending") throw new Error("Only an unfinished todo can be focused.")
          const now=Date.now()
          items[index]={...items[index],startedAt:items[index].startedAt || now,...(input.detail!==undefined?{detail:titleOf(input.detail)}:{}),updatedBy:actor}
          activeId=items[index].id
        } else if (input.action === "update") {
          if (input.title === undefined && input.status === undefined) throw new Error("Provide a todo title or status to update.")
          const previous=items[index], now=Date.now()
          items[index] = { ...previous, ...(input.title !== undefined ? { title: titleOf(input.title) } : {}), ...(input.status !== undefined ? { status: input.status } : {}), updatedBy: actor,
            ...(input.status === "completed" && previous.status !== "completed" ? { completedAt:now, ...(previous.startedAt!==undefined?{durationMs:Math.max(0,now-previous.startedAt)}:{}) } : {}),
            ...(input.status === "pending" && previous.status === "completed" ? { startedAt:now, completedAt:undefined, durationMs:undefined } : {}) }
          if (previous.id === activeId && input.status === "completed") {
            const next=items.find(item=>item.status==="pending")
            activeId=next?.id
            if(next && next.startedAt===undefined) next.startedAt=now
          } else if (input.status === "pending" && !activeId) {
            activeId=previous.id
            items[index].startedAt ??= now
          }
        } else if (input.action === "remove") {
          const [removed]=items.splice(index,1)
          if(removed.id===activeId){const next=items.find(item=>item.status==="pending");activeId=next?.id;if(next&&next.startedAt===undefined)next.startedAt=Date.now()}
        }
        else {
          if (input.beforeId !== null && (!items.some(item => item.id === input.beforeId) || input.beforeId === input.id)) throw new Error("Choose another todo as the move destination, or null for the end.")
          const [item] = items.splice(index, 1)
          items.splice(input.beforeId === null ? items.length : items.findIndex(item => item.id === input.beforeId), 0, { ...item, updatedBy: actor })
        }
      }
      const next = { ...state, revision: state.revision + 1, items, activeId }
      persist(next, [...receipts, { id: requestId, input: fingerprint }].slice(-256))
      return snapshot()
    },
  }
}

/** Fixed private bootstrap basename only; never a renderer-provided file path. */
export function readTodoSeed(directory) {
  try { return validateTodoState(readPrivateTodoJson(join(directory, "todo-seed.json"), 1024 * 1024, "Todo seed file")) }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("The declared Todo seed file is missing")
    throw error
  }
}

export function todoConnection() {
  const socket = process.env.STILL_TODO_SOCKET, token = process.env.STILL_TODO_TOKEN
  if (!socket || !token) throw new Error("The Still todo service is not connected to this execution.")
  return { socket, token }
}

function lines(stream, onLine, onError) {
  const decoder = new StringDecoder("utf8")
  let buffer = ""
  stream.on("data", chunk => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > 1024 * 1024) { buffer = ""; onError(new Error("Todo protocol frame is too large.")); return }
    let end
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      try { onLine(JSON.parse(line)) } catch (error) { onError(error) }
    }
  })
}

export function requestTodos(connection, input, requestId = randomUUID(), signal, method = "_still/todos") {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Todo request cancelled.")); return }
    const socket = createConnection(connection.socket)
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new Error("Todo request cancelled. Refresh the list before retrying."))
    const timer = setTimeout(() => finish(new Error("Todo response timed out. Refresh the list before retrying.")), 15000)
    signal?.addEventListener("abort", abort, { once: true })
    socket.once("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: { token: connection.token, input, requestId } }) + "\n"))
    socket.on("error", error => finish(error))
    socket.on("close", () => finish(new Error("Todo connection closed. Refresh the list before retrying.")))
    lines(socket, message => {
      if (message.id !== requestId) return
      if (message.error) finish(new Error(message.error.message || "Todo operation failed."))
      else if (message.result?.todos) finish(null, message.result.todos)
      else finish(new Error("The worker omitted its todo snapshot."))
    }, error => finish(error))
  })
}

export function markTodoToolReady(connection) {
  return requestTodos(connection, { action: "list" }, randomUUID(), undefined, "_still/todo_tool_ready")
}

async function mcp() {
  const connection = todoConnection(), client = randomUUID()
  const send = message => process.stdout.write(JSON.stringify(message) + "\n")
  const handle = async message => {
    if (!object(message) || message.id === undefined) return
    const { id, method, params } = message
    if (typeof id !== "string" && typeof id !== "number") { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request ID." } }); return }
    let result
    try {
      if (method === "initialize") result = { protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(params?.protocolVersion) ? params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "still-todos", version: "1.0.0" } }
      else if (method === "ping") result = {}
      else if (method === "tools/list") { await markTodoToolReady(connection); result = { tools: [todoTool] } }
      else if (method === "tools/call") {
        try {
          if (params?.name !== todoTool.name) throw new Error("Unknown Still tool.")
          const list = await requestTodos(connection, params.arguments, `${client}:${createHash("sha256").update(JSON.stringify(id)).digest("hex")}`)
          result = { content: [{ type: "text", text: JSON.stringify(list) }], structuredContent: list }
        } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] } }
      } else { send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown MCP method." } }); return }
      send({ jsonrpc: "2.0", id, result })
    } catch (error) { send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } }) }
  }
  lines(process.stdin, message => { void handle(message) }, () => send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP JSON." } }))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] === "mcp") await mcp()
