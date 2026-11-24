// Parent tools and guidance queues run on the remote worker, not in a mounted UI.
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, closeSync, copyFileSync, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { recordSharedWorker, setSharedChildTitle, sharedLibrary } from "./shared-library.mjs"

const hash = text => createHash("sha256").update(text).digest("hex")
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const providers = { opencode: "OpenCode", pi: "Pi", codex: "Codex", claude: "Claude Code", gemini: "Gemini CLI" }
const RECEIPT_LIMIT = 512, RECEIPT_MIN_AGE = 60 * 60 * 1000
// Marks a read-only result that finishes outside the serialized operation lane.
const deferred = Symbol("deferred")
const executablePath = value => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/\p{Cc}/u.test(value)

// Never blocks the parent worker's event loop, which also streams the parent's own turn.
function onPath(name) {
  return new Promise(resolve => {
    const probe = spawn("sh", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "still", name], { stdio: "ignore" })
    const timer = setTimeout(() => { probe.kill("SIGKILL"); resolve(false) }, 2000)
    probe.once("error", () => { clearTimeout(timer); resolve(false) })
    probe.once("exit", code => { clearTimeout(timer); resolve(code === 0) })
  })
}

function privateJson(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 4 * 1024 * 1024) throw new Error("Unsafe subagent coordination record")
    return JSON.parse(readFileSync(fd, "utf8"))
  } finally { closeSync(fd) }
}

export class ChildTransport {
  constructor(config, changed) {
    this.config = config
    this.changed = changed
    this.requests = new Map()
    this.messages = new Set()
    this.configOptions = []
    this.busy = false
    // Keyed by request identity: answering one of two approvals must not hide the other.
    this.pendingRequests = new Set()
    this.turn = null
    this.lastResult = null
    this.activity = ""
    this.waiters = new Set()
    this.generation = 0
    this.promptId = null
    this.sessionId = null
    this.ended = false
    this.caughtUp = false
    this.sequence = 0
    this.remoteCursor = 0
  }

  async connect() {
    this.process = spawn(process.execPath, [join(this.config.directory, "transport.mjs"), "attach", Buffer.from(JSON.stringify(this.config)).toString("base64")], { stdio: ["pipe", "pipe", "pipe"] })
    let buffer = "", stderr = ""
    const decoder = new StringDecoder("utf8")
    this.process.stdin.on("error", error => this.fail(error.message))
    this.process.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4000) })
    this.process.stdout.on("data", bytes => {
      buffer += decoder.write(bytes)
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { this.fail("Subagent frame exceeded the protocol limit"); return }
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try { this.receive(JSON.parse(line)) } catch (error) { this.fail(error.message) }
      }
    })
    this.process.on("error", error => this.fail(error.message))
    // An ended execution's read-only replay is closed deliberately; its final state stays valid.
    this.process.on("exit", () => { if (!this.ended) this.fail(stderr || "The subagent transport disconnected; its remote worker was not stopped.") })
    await this.request("initialize", { protocolVersion: 1, clientInfo: { name: "still-server-coordinator", version: "1" }, clientCapabilities: {} })
    const session = await this.request("session/new", { cwd: this.config.cwd, mcpServers: [] })
    this.sessionId = session.sessionId
    this.configOptions = session.configOptions || []
    this.generation = session._meta?.configGeneration || 0
    const until = Date.now() + 10_000
    while (!this.caughtUp) {
      if (this.failure) throw new Error(this.failure)
      if (Date.now() > until) throw new Error("Subagent catch-up timed out; no task was sent.")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return this
  }

  receive(frame) {
    if (Number.isSafeInteger(frame._still?.index)) this.remoteCursor = Math.max(this.remoteCursor, frame._still.index)
    const pending = !frame.method ? this.requests.get(String(frame.id)) : undefined
    if (pending) {
      this.requests.delete(String(frame.id)); clearTimeout(pending.timer)
      if (frame.error) pending.reject(new Error(frame.error.message || "Subagent operation rejected"))
      else pending.resolve(frame.result)
      if (frame.result?.configOptions) this.configOptions = frame.result.configOptions
    }
    if (frame.method === "_still/prompt_accepted") {
      this.messages.add(frame.params.messageId); this.busy = true; this.promptId = frame.params.promptId
      this.turn = { promptId: frame.params.promptId, messageId: frame.params.messageId, source: frame.params.source || "user", text: "" }
      this.activity = ""
    }
    if (frame.method === "_still/turn_finished") {
      // A result belongs to the turn that produced it, not to a rolling output tail.
      const turn = this.turn || { promptId: frame.params?.promptId ?? null, messageId: null, source: null, text: "" }
      this.lastResult = { ...turn, resultIndex: frame._still?.index || 0, ...(frame.params?.stopReason ? { stopReason: frame.params.stopReason } : {}), ...(frame.params?.error ? { error: String(frame.params.error).slice(0, 1000) } : {}) }
      this.turn = null; this.activity = ""
      this.busy = false; this.pendingRequests.clear(); this.promptId = null
    }
    if (frame.method === "_still/config_generation") this.generation = frame.params.configGeneration
    if (frame.method === "_still/caught_up") {
      this.caughtUp = true; this.busy = frame.params.busy; this.promptId = frame.params.activePrompt; this.ended = frame.params.ended === true
    }
    if (["session/request_permission", "elicitation/create"].includes(frame.method) && frame.id !== undefined) this.pendingRequests.add(JSON.stringify(frame.id))
    if (frame.method === "_still/request_outcome") this.pendingRequests.delete(JSON.stringify(frame.params?.requestId))
    if (frame.method === "session/update") {
      const update = frame.params?.update
      if (update?.configOptions) this.configOptions = update.configOptions
      // Only the agent's reply is a result; thoughts and echoed prompts are not.
      if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
        this.turn ||= { promptId: this.promptId, messageId: null, source: null, text: "" }
        this.turn.text = [...this.turn.text + update.content.text].slice(-4000).join("")
      }
      if (update?.sessionUpdate === "tool_call" && typeof update.title === "string") this.activity = [...update.title].slice(0, 300).join("")
    }
    if (["_still/unavailable", "_still/upgrade_required", "_still/error"].includes(frame.method)) this.fail(frame.params?.message || "This subagent requires recovery or a worker upgrade.")
    this.changed(frame)
    this.notify()
  }

  get needsAttention() { return this.pendingRequests.size > 0 }

  get lastUpdate() { return this.turn?.text ? [...this.turn.text].slice(-1000).join("") : this.activity }

  notify() { for (const check of [...this.waiters]) check() }

  /** Resolves true on timeout, false once `predicate` holds. Never polls the worker. */
  waitFor(predicate, ms) {
    if (predicate()) return Promise.resolve(false)
    return new Promise(resolve => {
      const done = timedOut => { clearTimeout(timer); this.waiters.delete(check); resolve(timedOut) }
      const check = () => { if (predicate()) done(false) }
      const timer = setTimeout(() => done(true), ms)
      this.waiters.add(check)
    })
  }

  fail(message) {
    this.failure = message
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    this.requests.clear()
    this.notify()
  }

  request(method, params) {
    if (this.failure) return Promise.reject(new Error(this.failure))
    const requestId = `coordinator-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error("Subagent acknowledgement timed out. Reconcile the same operation before retrying.")) }, 15_000)
      this.requests.set(requestId, { resolve, reject, timer })
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n")
    })
  }

  async prompt(text, messageId) {
    if (this.messages.has(messageId)) return
    await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }],
      _meta: { messageId, source: "parentAgent", expectedConfigGeneration: this.generation } })
  }

  close() { this.process?.stdin.end() }
}

export function createServerSubagents(config, ownsConversation = () => true) {
  const parentId = config.conversationId || config.executionId
  const root = join(process.env.HOME, ".local/state/still/agent-children", hash(parentId))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error("Unsafe server subagent directory")
  const file = join(root, "state.json")
  let state
  try { state = privateJson(file) }
  catch (error) { if (error.code !== "ENOENT") throw error; state = { version: 1, parentId, cwd: config.cwd, children: {}, receipts: [] } }
  if (state.version !== 1 || state.parentId !== parentId || state.cwd !== config.cwd || !state.children || !Array.isArray(state.receipts) || state.receipts.length > 512 || Object.keys(state.children).length > 256) throw new Error("Subagent coordination scope changed; the existing record was kept")
  state.cancelIntents ||= {}
  const clients = new Map(), draining = new Set()
  let closing = false
  let lane = Promise.resolve()
  const assertOwner = () => { if (closing || !ownsConversation()) throw new Error("This execution no longer owns server-side child coordination.") }
  const persist = () => {
    assertOwner()
    const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600)
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
    const directory = openSync(root, "r"); try { fsyncSync(directory) } finally { closeSync(directory) }
  }
  persist()

  // The app's discovery for this host is the eligibility source: it knows the configured
  // executable and whether the integration actually connected. PATH presence is only a
  // fallback for workers launched without it, and is reported as unverified.
  const verified = new Map((Array.isArray(config.subagentAgents) ? config.subagentAgents : [])
    .filter(entry => entry && Object.hasOwn(providers, entry.agentId) && (entry.executable === undefined || executablePath(entry.executable)))
    .map(entry => [entry.agentId, entry]))
  const executableFor = agentId => verified.get(agentId)?.executable || agentId
  let availability = null
  const available = async () => {
    if (availability && Date.now() - availability.at < 60_000) return availability.value
    const value = await Promise.all(Object.entries(providers).map(async ([agentId, name]) => {
      if (agentId === config.agentId) return { agentId, name, available: true, verified: true }
      const entry = verified.get(agentId)
      if (entry) return { agentId, name, available: entry.available === true, verified: true, ...(entry.available === true ? {} : { reason: typeof entry.reason === "string" && entry.reason ? [...entry.reason].slice(0, 300).join("") : "Not available on this server." }) }
      const present = await onPath(agentId)
      return { agentId, name, available: present, verified: false, reason: present ? "Found on PATH; Still has not verified its sign-in or integration on this server." : "Not found on this server's PATH." }
    }))
    availability = { at: Date.now(), value }
    return value
  }
  const deliverable = child => !child.paused && child.guidance.some(item => !item.executionId || item.executionId === child.config.executionId)
  // Counts from the saved worker records instead of attaching to every retained child.
  const activeChildren = () => {
    let active = 0
    for (const child of Object.values(state.children)) {
      const client = clients.get(child.id)
      if (client?.caughtUp && !client.failure) { if (!client.ended && (child.prepared || client.busy || client.needsAttention)) active++; continue }
      try {
        const saved = privateJson(join(child.config.directory, "state.json"))
        if (saved.executionId !== child.config.executionId || !saved.closed && !saved.ended && (child.prepared || saved.busy)) active++
      } catch { active++ } // An unreadable record is not proof the child stopped.
    }
    return active
  }
  // Frees one retained slot by forgetting an ended, idle child. Its history stays in the shared library.
  const evictEnded = () => {
    for (const child of Object.values(state.children)) {
      if (child.prepared || child.guidance.length) continue
      try {
        const saved = privateJson(join(child.config.directory, "state.json"))
        if (saved.executionId !== child.config.executionId || !(saved.closed || saved.ended) || saved.busy) continue
      } catch { continue }
      clients.get(child.id)?.close(); clients.delete(child.id)
      delete state.children[child.id]
      return true
    }
    return false
  }
  // Delivery stays deduplicated by message identity in the child worker, and prepare by
  // its derived child ID, so forgetting receipts older than an hour cannot duplicate work.
  const makeReceiptRoom = () => {
    while (state.receipts.length >= RECEIPT_LIMIT) {
      const oldest = state.receipts[0]
      if (Number.isSafeInteger(oldest.at) && Date.now() - oldest.at < RECEIPT_MIN_AGE) return false
      state.receipts.shift(); delete state.cancelIntents[oldest.id]
    }
    const intents = Object.keys(state.cancelIntents)
    for (const key of intents.slice(0, Math.max(0, intents.length - RECEIPT_LIMIT))) delete state.cancelIntents[key]
    return true
  }
  const settings = client => {
    const select = (categories, ids) => client.configOptions.find(option => categories.includes(option.category) || ids.includes(option.id))
    const describe = option => option ? { id: option.id, name: option.name, current: option.currentValue,
      choices: (option.options || []).flatMap(item => Object.hasOwn(item, "value") ? [item] : item.options || []).map(item => ({ id: item.value, name: item.name })) } : undefined
    return { model: describe(select(["model"], ["model"])), effort: describe(select(["thought_level", "reasoning", "effort", "variant", "variants"], [])), mode: describe(select(["mode", "agent", "agent_mode"], [])) }
  }

  async function clientFor(child) {
    let client = clients.get(child.id)
    if (client && !client.failure) { await client.ready; return client }
    client = new ChildTransport({ ...child.config, create: !child.config.existingOnly && !existsSync(join(child.config.directory, "state.json")) }, frame => {
      if (closing || clients.get(child.id) !== client) return
      if (frame.method === "_still/prompt_accepted" && child.prepared) { child.prepared = false; persist() }
      if (frame.method === "_still/cancel_requested" && (frame._still?.index || 0) > (child.guidanceResumeCursor || 0)) { child.paused = true; persist() }
      if (client.caughtUp) {
        if (frame.method === "_still/turn_finished") for (const candidate of Object.values(state.children)) void drain(candidate).catch(() => {})
        else void drain(child).catch(() => {})
      }
    })
    clients.set(child.id, client)
    client.ready = client.connect()
    try {
      await client.ready
      // An ended execution is read-only history: keep its final state, release the process.
      if (client.ended) client.close()
      return client
    }
    catch (error) { clients.delete(child.id); client.close(); throw error }
  }

  async function detail(child) {
    let client
    try { client = await clientFor(child) }
    catch (error) { return { childId: child.id, title: child.title, agentId: child.agentId, status: "Unavailable", error: error.message, queuedGuidance: child.guidance.length, guidancePaused: child.paused } }
    return { childId: child.id, title: child.title, agentId: child.agentId, agentName: providers[child.agentId] || child.agentId,
      status: client.failure ? "Unavailable" : client.ended ? "Ended" : client.needsAttention ? "Needs you" : client.busy ? "Working" : child.prepared ? "Prepared" : "Ready",
      settings: settings(client), prepared: child.prepared, turnActive: client.busy, needsAttention: client.needsAttention,
      queuedGuidance: child.guidance.filter(item => !item.executionId || item.executionId === child.config.executionId).length,
      heldGuidance: child.guidance.filter(item => item.executionId && item.executionId !== child.config.executionId).map(item => ({ messageId: item.messageId, message: item.message })),
      guidancePaused: child.paused, lastUpdate: client.lastUpdate,
      ...(client.lastResult ? { lastResult: client.lastResult, newResult: client.lastResult.resultIndex > (child.seenResultIndex || 0) } : {}) }
  }
  // Marks the reported result as read by the parent; persisted with the next state write.
  const reported = (child, value) => {
    if (value.lastResult && value.lastResult.resultIndex > (child.seenResultIndex || 0)) child.seenResultIndex = value.lastResult.resultIndex
    return value
  }

  function adoptExistingChildren() {
    let after = "", changed = false
    do {
      const page = sharedLibrary(process.env.HOME, { after })
      for (const remote of page.rows) {
        if (remote.parentConversationId !== parentId || remote.cwd !== config.cwd || remote.protocolVersion !== 4 || !remote.agentSessionId) continue
        const known = state.children[remote.conversationId]
        if (known && known.config.executionId === remote.executionId) continue
        // An unknown ended child cannot receive guidance; adopting it would only refill the quota.
        if (!known && remote.available === false) continue
        // Never let one extra human-created child break every parent operation.
        if (Object.keys(state.children).length >= 256 && !known && !evictEnded()) continue
        const previousExecution = known?.config.executionId
        const previousClient = clients.get(remote.conversationId)
        clients.delete(remote.conversationId)
        previousClient?.close()
        const child = known || { id: remote.conversationId, title: remote.shared.values.title || "Subagent", agentId: remote.agentId, prepared: remote.prepared === true, paused: true, guidance: [] }
        if (known) for (const item of child.guidance) item.executionId ||= previousExecution
        child.config = { directory: join(process.env.HOME, ".local/state/still/agents", remote.executionId), executionId: remote.executionId,
          conversationId: remote.conversationId, parentConversationId: parentId, cwd: config.cwd, agentId: remote.agentId,
          command: [], env: {}, continuity: true, requireContinuity: true, existingOnly: true }
        if (known) child.paused = true
        state.children[child.id] = child
        changed = true
      }
      after = page.next
    } while (after)
    if (changed) persist()
  }

  async function create(agentId, title, requestId) {
    assertOwner()
    const childId = `subagent-${hash(`${parentId}:${requestId}`).slice(0, 32)}`
    if (state.children[childId]) return state.children[childId]
    if (!(await available()).some(agent => agent.agentId === agentId && agent.available)) throw new Error("Choose an available agent returned by list.")
    if (Object.keys(state.children).length >= 256 && !evictEnded()) throw new Error("This parent reached its retained-child quota and no ended child can be released. Existing children and history were preserved.")
    if (activeChildren() >= 3) throw new Error("This parent already has three active subagents (prepared, working, or waiting for you). Wait for one to finish before preparing another.")
    const executionId = `agent-${hash(childId).slice(0, 32)}`
    const directory = join(process.env.HOME, ".local/state/still/agents", executionId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error("Unsafe child execution directory")
    for (const name of ["transport.mjs", "todos.mjs", "todo-pi.mjs", "recovery.mjs", "shared-library.mjs", "subagents.mjs", "bridge.mjs"]) {
      const destination = join(directory, name)
      if (!existsSync(destination)) copyFileSync(join(config.directory, name), destination, constants.COPYFILE_EXCL)
    }
    let command, env
    if (agentId === config.agentId) {
      command = [...config.command]
      if (config.env?.STILL_AGENT_DRIVER) command = [process.execPath, join(directory, "bridge.mjs")]
      env = { ...config.env }
    } else if (agentId === "gemini") { command = [executableFor(agentId), "--acp"]; env = {} }
    else { command = [process.execPath, join(directory, "bridge.mjs")]; env = { STILL_AGENT_DRIVER: agentId, STILL_AGENT_EXECUTABLE: executableFor(agentId) } }
    const child = { id: childId, title, agentId, prepared: true, paused: false, guidance: [],
      config: { directory, executionId, conversationId: childId, parentConversationId: parentId, cwd: config.cwd, agentId,
        command, env, continuity: true, requireContinuity: true, sharedLibrary: true, serverSubagents: false, title } }
    state.children[childId] = child
    persist() // Reserve stable identities before starting a provider session.
    await clientFor(child)
    return child
  }

  // Applies model first: effort and mode choices depend on it, so each is validated
  // against the choices offered after the previous change. Then verifies the final
  // combination, since a later change (e.g. mode) may reset an earlier one.
  async function configure(child, client, requested) {
    await applySetting(child, client, "model", requested.modelId)
    await applySetting(child, client, "effort", requested.effort)
    await applySetting(child, client, "mode", requested.modeId)
    const current = settings(client)
    const drifted = [["model", requested.modelId], ["effort", requested.effort], ["mode", requested.modeId]]
      .filter(([key, value]) => value !== undefined && current[key]?.current !== value)
      .map(([key, value]) => `${key} is ${JSON.stringify(current[key]?.current ?? null)}, not ${JSON.stringify(value)}`)
    if (drifted.length) throw new Error(`Prepared child ${child.id}: the provider did not keep the requested settings (${drifted.join("; ")}). No task was sent; inspect it and prepare it again.`)
  }

  async function applySetting(child, client, key, requested) {
    assertOwner()
    if (requested === undefined) return
    const option = settings(client)[key]
    if (!option) throw new Error(`Prepared child ${child.id} does not offer a selectable ${key}. No task was sent; omit ${key} to keep the provider default.`)
    if (typeof requested !== "string" || !option.choices.some(choice => choice.id === requested)) throw new Error(`Unsupported ${key} ID ${JSON.stringify(requested)} for prepared child ${child.id}. Choices: ${option.choices.map(choice => `${choice.name} (${choice.id})`).join(", ") || "none"}. No task was sent.`)
    if (option.current === requested) return
    const result = await client.request("session/set_config_option", { sessionId: client.sessionId, configId: option.id, value: requested, _meta: { expectedConfigGeneration: client.generation } })
    if (result.configOptions) client.configOptions = result.configOptions
    // The reply may precede its generation notification in a different pipe read.
    // Query the worker's serialized state instead of guessing/incrementing locally.
    const status = await client.request("_still/status", {})
    if (!Number.isSafeInteger(status.configGeneration)) throw new Error("The child did not confirm its configuration generation; no task was sent.")
    client.generation = status.configGeneration
  }

  async function drain(child) {
    if (closing || !ownsConversation() || draining.has(child.id) || child.paused || !child.guidance.length) return
    const client = await clientFor(child)
    if (!client.caughtUp || client.failure || client.busy || client.needsAttention || client.ended) return
    draining.add(child.id)
    try {
      const next = child.guidance.find(item => !item.executionId || item.executionId === child.config.executionId)
      if (!next) return
      assertOwner()
      await client.prompt(next.message, next.messageId)
      if (client.messages.has(next.messageId)) { child.guidance = child.guidance.filter(item => item.messageId !== next.messageId); persist() }
    } finally { draining.delete(child.id) }
  }

  async function apply(input, requestId) {
    assertOwner()
    if (config.parentConversationId) throw new Error("Subagents cannot create or manage nested subagents.")
    if (typeof requestId !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new Error("Invalid subagent operation identity")
    const fingerprint = hash(JSON.stringify(input))
    const previous = state.receipts.find(receipt => receipt.id === requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("Subagent operation identity was reused with different input")
      return previous.result
    }
    adoptExistingChildren()
    const mutation = ["prepare", "spawn", "guide", "cancel"].includes(input.action)
    if (mutation && !makeReceiptRoom()) throw new Error("This parent made 512 subagent changes within the last hour. Wait before making more; earlier operation identities were kept.")
    let result
    const find = () => {
      if (!id(input.childId) || !Object.hasOwn(state.children, input.childId)) throw new Error("This child does not belong to the parent conversation.")
      return state.children[input.childId]
    }
    if (input.action === "list") {
      result = { agents: await available(), children: await Promise.all(Object.values(state.children).map(async child => reported(child, await detail(child)))), instruction: "Prepare a child first to inspect exact model/effort/mode IDs. Agents marked verified:false were only found on PATH. Coordination and guidance continue on this server with both apps closed." }
    } else if (input.action === "prepare") {
      const requested = ["modelId", "effort", "modeId"].some(key => input[key] !== undefined)
      if (input.childId !== undefined) {
        // Re-prepare: change an unused child's settings without creating another conversation.
        const child = find()
        if (input.agentId && child.agentId !== input.agentId) throw new Error(`Prepared child ${child.id} belongs to another provider. No task was sent.`)
        const client = await clientFor(child)
        if (client.ended || client.failure) throw new Error(`Prepared child ${child.id} is not available. No task was sent; prepare a new child with an agentId instead.`)
        if (!child.prepared || client.messages.size || client.busy) throw new Error(`Child ${child.id} has already started work, so it can no longer be prepared. No task was sent; prepare a new child with an agentId instead.`)
        await configure(child, client, input)
        if (input.title?.trim()) child.title = input.title.trim()
        persist()
        result = { ...await detail(child), note: requested ? "Settings applied and verified; no model task has been sent. The effort and mode choices shown are those offered for the selected model." : "No settings were requested; no model task has been sent." }
      } else {
        const child = await create(input.agentId, input.title?.trim() || `Prepared ${providers[input.agentId] || "subagent"}`, requestId)
        if (requested) await configure(child, await clientFor(child), input)
        result = { ...await detail(child), note: requested ? "Provider session prepared and the requested settings verified; no model task has been sent." : "Provider session prepared; no model task has been sent." }
      }
    } else if (input.action === "spawn") {
      if (!input.childId) throw new Error("Prepare a child first, then spawn with its stable childId. A lost acknowledgement must not create another paid task.")
      if (typeof input.title !== "string" || !input.title.trim() || typeof input.task !== "string" || !input.task.trim() || input.task.length > 12000) throw new Error("Spawn requires a title and a task of at most 12,000 characters.")
      const child = find()
      if (input.agentId && child.agentId !== input.agentId) throw new Error("The prepared child belongs to another provider.")
      const client = await clientFor(child)
      if (client.ended) throw new Error("This child execution ended. Recover its saved provider session explicitly before queuing guidance.")
      const messageId = `parent-task-${hash(`${parentId}:${requestId}`)}`
      if (!client.messages.has(messageId)) {
        if (!child.prepared || client.messages.size) throw new Error("Spawn requires an unused prepared child.")
        await configure(child, client, input)
        assertOwner()
        await client.prompt(input.task.trim(), messageId)
      }
      child.prepared = false; child.title = input.title.trim(); persist()
      // The task is already accepted: a catalog failure must not read as a failed spawn.
      let warning
      try {
        recordSharedWorker(process.env.HOME, child.config.executionId)
        setSharedChildTitle(process.env.HOME, child.id, parentId, child.title)
      } catch (error) { warning = `The task was sent, but the shared conversation list was not updated yet: ${error.message}` }
      result = { ...await detail(child), status: "Started", ...(warning ? { warning } : {}) }
    } else if (input.action === "inspect") {
      const child = find()
      result = reported(child, await detail(child))
    } else if (input.action === "wait") {
      // Read-only: resolve the child here, then wait outside the lane so other calls proceed.
      const child = find()
      const client = await clientFor(child).catch(() => null)
      const timeout = Math.max(1000, Math.min(15000, input.timeoutMs || 5000))
      return { [deferred]: async () => {
        let timedOut = false
        if (client) {
          const settled = () => client.failure || client.ended || !client.busy && !client.needsAttention && !deliverable(child)
          // Starting a queued turn is not news; a result, a request, an answer, or a failure is.
          const signature = () => JSON.stringify([client.failure || "", client.ended, [...client.pendingRequests].sort(), client.lastResult?.resultIndex || 0])
          const initial = signature()
          // Returns on the first real change rather than always sleeping the full timeout.
          timedOut = await client.waitFor(() => settled() || signature() !== initial, timeout)
        }
        return { ...reported(child, await detail(child)), timedOut }
      } }
    } else if (input.action === "guide") {
      const child = find()
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 4000) throw new Error("Guidance must be 1–4,000 characters.")
      const messageId = `parent-guidance-${hash(`${parentId}:${requestId}`)}`
      const client = await clientFor(child)
      if (client.ended) throw new Error("This child execution ended. Recover it explicitly before queuing guidance.")
      if (client.messages.has(messageId)) result = { childId: child.id, status: "Delivered" }
      else {
        if (child.guidance.length >= 100) throw new Error("This child's guidance queue is full.")
        if (!child.guidance.some(item => item.messageId === messageId)) child.guidance.push({ messageId, message: input.message.trim(), executionId: child.config.executionId })
        child.paused = false; child.guidanceResumeCursor = client.remoteCursor; persist()
        result = { childId: child.id, status: "Queued", note: "Saved on the server. Delivery waits for a safe turn boundary and never approves user-owned requests." }
        void drain(child).catch(() => {})
      }
    } else if (input.action === "cancel") {
      const child = find(), client = await clientFor(child)
      child.paused = true; persist()
      if (!Object.hasOwn(state.cancelIntents, requestId)) { state.cancelIntents[requestId] = { fingerprint, promptId: client.promptId }; persist() }
      const intent = state.cancelIntents[requestId]
      if (intent.fingerprint !== fingerprint) throw new Error("Cancellation identity was reused with another payload")
      assertOwner()
      if (client.busy && intent.promptId !== null) await client.request("session/cancel", { sessionId: client.sessionId, _meta: { promptId: intent.promptId } })
      result = { childId: child.id, status: client.busy ? "Cancellation requested" : "Already idle", guidancePaused: true }
    } else throw new Error("Unsupported subagent operation")
    if (mutation) { state.receipts.push({ id: requestId, fingerprint, result, at: Date.now() }); persist() }
    return result
  }

  // Reattach only children with deliverable guidance after a parent worker restart;
  // others attach on demand instead of holding a transport process each.
  for (const child of Object.values(state.children)) if (deliverable(child)) void clientFor(child).then(() => drain(child)).catch(() => {})
  return {
    apply(input, requestId) {
      const phase = lane.then(() => apply(input, requestId))
      lane = phase.catch(() => {})
      return phase.then(value => value?.[deferred] ? value[deferred]() : value)
    },
    close() {
      closing = true
      return Promise.all([...clients.values()].map(client => new Promise(resolve => {
        if (!client.process || client.process.exitCode !== null || client.process.signalCode !== null) { resolve(); return }
        client.process.once("exit", resolve)
        client.close()
      })))
    },
  }
}
