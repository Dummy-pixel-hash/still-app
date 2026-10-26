/** Still's bundled remote driver host. No npm packages or provider credentials are installed.
 * Native protocols: Pi RPC, Codex App Server, Claude stream-json; OpenCode HTTP v2.
 * The SSH-facing envelope is ACP v1 so all drivers share Still's lifecycle and UI.
 */
import { spawn } from "node:child_process"
import { randomUUID, randomBytes } from "node:crypto"
import { StringDecoder } from "node:string_decoder"

const LIMIT = 2 * 1024 * 1024
export function frameReader(onFrame, onError) {
  const decoder = new StringDecoder("utf8")
  let pending = ""
  return chunk => {
    pending += decoder.write(chunk)
    let end
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1)
      if (!line) continue
      if (Buffer.byteLength(line) > LIMIT) { onError(new Error("Protocol frame exceeds 2 MiB")); return }
      try { onFrame(JSON.parse(line)) } catch (error) { onError(error) }
    }
    if (Buffer.byteLength(pending) > LIMIT) { pending = ""; onError(new Error("Protocol frame exceeds 2 MiB")) }
  }
}
export function sseReader(onEvent, onError) {
  const decoder = new StringDecoder("utf8")
  let pending = ""
  return chunk => {
    pending += decoder.write(chunk)
    let match
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const record = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length)
      const data = record.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
      if (data) { try { onEvent(JSON.parse(data)) } catch (error) { onError(error) } }
    }
    if (Buffer.byteLength(pending) > LIMIT) { pending = ""; onError(new Error("OpenCode event exceeds 2 MiB")) }
  }
}
export const textOf = value => typeof value === "string" ? value : Array.isArray(value)
  ? value.map(block => block?.text || block?.content?.text || "").filter(Boolean).join("\n") : ""
export const toolKind = name => /read|view|open_file/i.test(name) ? "read" : /grep|glob|search|find/i.test(name) ? "search"
  : /edit|write|patch|replace/i.test(name) ? "edit" : /bash|shell|terminal|exec/i.test(name) ? "execute"
    : /agent|task|spawn/i.test(name) ? "subagent" : "other"
const contentOf = result => (result?.content || []).flatMap(block => block.type === "text" ? [{ type: "content", content: block }] : [])
const option = (id, name, category, currentValue, options) => ({ id, name, category, type: "select", currentValue, options })
const values = list => list.map(value => ({ value, name: value }))
const errorText = error => error?.message || error?.error?.message || String(error)
const deadline = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
  promise.then(resolve, reject).finally(() => clearTimeout(timer))
})

export class Peer {
  constructor(executable, args, handler, env = {}) {
    const inherited = { ...process.env, ...env }; delete inherited.CLAUDECODE
    this.child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd(), env: inherited, detached: process.platform !== "win32" })
    this.pending = new Map(); this.serial = 0; this.stderr = ""; this.closed = false
    this.onEvent = handler; this.onFailure = () => {}
    this.child.stdout.on("data", frameReader(value => this.frame(value), error => this.fail(error)))
    this.child.stderr.on("data", data => { this.stderr = (this.stderr + data.toString()).slice(-16000) })
    this.child.stdin.on("error", error => this.fail(error))
    this.child.on("error", error => this.fail(error))
    this.child.on("exit", (code, signal) => { this.closed = true; this.fail(new Error(`Agent exited (${signal || code}). ${this.stderr.trim()}`)) })
  }
  frame(value) {
    const id = value.type === "control_response" ? value.response?.request_id : value.id
    const response = value.type === "response" || value.type === "control_response" || !value.method && ("result" in value || "error" in value)
    if (response && this.pending.has(String(id))) {
      const pending = this.pending.get(String(id)); this.pending.delete(String(id))
      const error = value.error || (value.success === false ? "Agent rejected the request" : undefined) || (value.response?.subtype === "error" ? value.response.error : undefined)
      if (error) pending.reject(new Error(errorText(error)))
      else pending.resolve(value.type === "control_response" ? value.response?.response || {} : value.type === "response" ? value.data : value.result)
    } else Promise.resolve(this.onEvent(value)).catch(error => this.onFailure(error))
  }
  send(value) {
    if (this.closed) throw new Error("The agent process has exited")
    this.child.stdin.write(JSON.stringify(value) + "\n", error => { if (error) this.fail(error) })
  }
  request(method, params = {}, protocol = "jsonrpc") {
    const id = `still-${++this.serial}`
    const frame = protocol === "pi" ? { ...params, id, type: method }
      : protocol === "claude" ? { type: "control_request", request_id: id, request: { subtype: method, ...params } }
        : { jsonrpc: "2.0", id, method, params }
    const task = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); try { this.send(frame) } catch (error) { reject(error) } })
    return deadline(task, 45000, method).finally(() => this.pending.delete(id))
  }
  fail(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.onFailure(error) }
  async close() {
    this.onFailure = () => {}
    this.child.stdin.end()
    const exited = new Promise(resolve => this.child.once("exit", resolve))
    if (this.closed) return
    try { await deadline(exited, 2000, "Agent shutdown") } catch {
      try { if (process.platform !== "win32") process.kill(-this.child.pid, "SIGTERM"); else this.child.kill("SIGTERM") } catch {}
      try { await deadline(exited, 2000, "Agent termination") } catch {
        try { if (process.platform !== "win32") process.kill(-this.child.pid, "SIGKILL"); else this.child.kill("SIGKILL") } catch {}
        await deadline(exited, 2000, "Agent process cleanup")
      }
    }
  }
}

export class Driver {
  constructor(host, executable) { this.host = host; this.executable = executable; this.configs = []; this.commands = []; this.id = ""; this.turn = null; this.message = 0; this.askQueue = Promise.resolve(); this.questionCount = 0 }
  update(update) { this.host.update(update) }
  text(text, reasoning = false, messageId) { if (text) this.update({ sessionUpdate: reasoning ? "agent_thought_chunk" : "agent_message_chunk", content: { type: "text", text }, _meta: { messageId } }) }
  tool(id, name, status, input, content, output) {
    this.update({ sessionUpdate: "tool_call_update", toolCallId: id, title: name, kind: toolKind(name), status, ...(input ? { rawInput: input } : {}), ...(content ? { content } : {}), ...(output !== undefined ? { rawOutput: output } : {}) })
  }
  configUpdate() { this.update({ sessionUpdate: "config_option_update", configOptions: this.configs }) }
  commandUpdate() { this.update({ sessionUpdate: "available_commands_update", availableCommands: this.commands }) }
  begin() {
    if (this.turn) throw new Error("The agent is already working")
    const done = new Promise((resolve, reject) => { this.turn = { resolve, reject } })
    // A fast protocol rejection can arrive before prompt() returns this promise.
    done.catch(() => {})
    return done
  }
  finish(cancelled = false) { const turn = this.turn; this.turn = null; turn?.resolve({ stopReason: cancelled ? "cancelled" : "end_turn" }) }
  fail(error) { const turn = this.turn; this.turn = null; if (turn) turn.reject(error); else this.update({ sessionUpdate: "session_error", message: errorText(error) }) }
  ask(method, params) {
    this.questionCount++
    const generation = this.host.questionGeneration
    const task = this.askQueue.then(() => generation !== this.host.questionGeneration ? { action: "cancel", outcome: { outcome: "cancelled" } } : this.host.ask(method, { ...params, sessionId: this.id }))
    this.askQueue = task.catch(() => {})
    return task.finally(() => { this.questionCount-- })
  }
  async permission(id, name, input, choices = ["allow", "deny"]) {
    const result = await this.ask("session/request_permission", { toolCall: { toolCallId: id, title: name, rawInput: input }, options: choices.map((choice, i) => ({ optionId: choice, name: i === 0 ? "Allow once" : "Reject", kind: i === 0 ? "allow_once" : "reject_once" })) })
    return result?.outcome?.outcome === "selected" ? result.outcome.optionId : choices[1]
  }
  async form(title, properties, required = Object.keys(properties)) {
    const result = await this.ask("elicitation/create", { mode: "form", message: title, requestedSchema: { type: "object", properties, required } })
    return result?.action === "accept" ? result.content : null
  }
  async cancelPending() { this.host.cancelQuestions() }
  async close() { await this.peer?.close() }
}

export class PiDriver extends Driver {
  async start(resume) {
    this.peer = new Peer(this.executable, ["--mode", "rpc", ...(resume ? ["--session", resume] : [])], value => this.event(value))
    this.peer.onFailure = error => this.fail(error)
    this.call = (method, params) => this.peer.request(method, params, "pi")
    const state = await this.call("get_state")
    this.id = state.sessionFile || state.sessionId
    if (!this.id) throw new Error("Pi did not return a session identity")
    this.resumable = !!state.sessionFile
    await this.catalog(state)
  }
  async catalog(state) {
    const [models, commands, thinking] = await Promise.all([
      this.call("get_available_models"), this.call("get_commands"), this.call("get_available_thinking_levels").catch(() => null),
    ])
    this.configs = []
    if (models?.models?.length) this.configs.push(option("model", "Model", "model", state.model ? `${state.model.provider}/${state.model.id}` : "", models.models.map(model => ({ value: `${model.provider}/${model.id}`, name: model.name || model.id }))))
    if (thinking?.levels?.length) this.configs.push(option("effort", "Reasoning", "thought_level", state.thinkingLevel || thinking.levels[0], values(thinking.levels)))
    this.commands = (commands?.commands || []).map(command => ({ name: command.name, description: command.description || "", source: command.source }))
    if (!this.commands.some(command => command.name === "compact")) this.commands.push({ name: "compact", description: "Compact the Pi conversation", source: "native", input: { hint: "Optional summary instructions" } })
    this.configUpdate(); this.commandUpdate()
  }
  async prompt(text) {
    const done = this.begin()
    this.operationType = /^\/compact(?:\s|$)/.test(text) ? "compact" : "prompt"
    try {
      const compact = text.match(/^\/compact(?:\s+([\s\S]*))?$/)
      if (compact && this.commands.find(command => command.name === "compact")?.source === "native") {
        await this.call("compact", compact[1] ? { customInstructions: compact[1] } : {})
        this.finish(); return done
      }
      await this.catalog(await this.call("get_state"))
      const response = await this.call("prompt", { message: text })
      if (response?.disposition === "handled") {
        const state = await this.call("get_state")
        if (!state.isStreaming && !state.isCompacting && !state.pendingMessageCount) this.finish()
      }
    } catch (error) { this.fail(error) }
    return done
  }
  async setConfig(id, value) {
    if (id === "model") { const [provider, ...model] = value.split("/"); await this.call("set_model", { provider, modelId: model.join("/") }) }
    else if (id === "effort") await this.call("set_thinking_level", { level: value })
    else throw new Error("Unknown Pi setting")
    await this.catalog(await this.call("get_state"))
  }
  async cancel() { const turn = this.turn; await this.call("clear_queue").catch(() => {}); await this.call("abort"); if (this.turn === turn) this.finish(true) }
  async event(event) {
    if (event.type === "message_start" && event.message?.role === "assistant") { this.message++; this.streamed = false }
    if (event.type === "message_update") {
      const part = event.assistantMessageEvent
      if (part?.type === "text_delta" || part?.type === "thinking_delta") { this.streamed = true; this.text(part.delta, part.type === "thinking_delta", `pi-${this.message}-${part.contentIndex}`) }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (!this.streamed) this.text(textOf(event.message.content), false, `pi-${this.message}`)
      if (event.message.errorMessage && event.message.stopReason === "error") this.fail(new Error(event.message.errorMessage))
    }
    if (event.type?.startsWith("tool_execution_")) {
      const result = event.result || event.partialResult
      this.tool(event.toolCallId, event.toolName, event.type === "tool_execution_end" ? event.isError ? "failed" : "completed" : "in_progress", event.args, result ? contentOf(result) : undefined, result?.details)
    }
    if (event.type === "agent_settled" && this.operationType !== "compact") this.finish(event.aborted)
    // Older Pi releases expose agent_end only. Confirm its actual state; never
    // mistake the prompt acceptance response for model completion.
    if (event.type === "agent_end" && !event.willRetry && this.operationType !== "compact") {
      const turn = this.turn
      const state = await this.call("get_state")
      if (this.turn === turn && !state.isStreaming && !state.isCompacting && !state.pendingMessageCount) this.finish()
    }
    if (event.type === "thinking_level_changed" && this.configs.some(option => option.id === "effort")) { this.configs.find(option => option.id === "effort").currentValue = event.level; this.configUpdate() }
    if (event.type === "auto_retry_start") this.update({ sessionUpdate: "notice", message: `Retry ${event.attempt}: ${event.errorMessage || "The provider is temporarily unavailable"}` })
    if (event.type === "auto_retry_end" && event.success === false) this.fail(new Error(event.finalError || "Pi exhausted its provider retries"))
    if (event.type === "extension_ui_request") {
      if (["select", "input", "editor", "confirm"].includes(event.method)) {
        const field = event.method === "confirm" ? { type: "string", enum: ["Yes", "No"] } : { type: "string", ...(event.options ? { enum: event.options } : {}) }
        const answer = await this.form(event.title || event.message || "Pi needs your input", { answer: field })
        this.peer.send({ type: "extension_ui_response", id: event.id, ...(event.method === "confirm" ? { confirmed: answer?.answer === "Yes" } : { value: answer?.answer }), cancelled: !answer })
      } else if (["notify", "setStatus", "setWidget", "setTitle"].includes(event.method)) {
        if (event.method === "notify") this.update({ sessionUpdate: "notice", message: event.message })
      } else this.peer.send({ type: "extension_ui_response", id: event.id, cancelled: true })
    }
  }
}

export class CodexDriver extends Driver {
  async start(resume) {
    this.peer = new Peer(this.executable, ["app-server"], value => this.event(value))
    this.peer.onFailure = error => this.fail(error)
    await this.peer.request("initialize", { clientInfo: { name: "still", title: "Still", version: "0.1.1" }, capabilities: { experimentalApi: true } })
    this.peer.send({ jsonrpc: "2.0", method: "initialized" })
    const account = await this.peer.request("account/read", {})
    if (account.requiresOpenaiAuth && !account.account) throw new Error("Codex is installed but needs sign-in. Run codex login on this server.")
    const result = await this.peer.request(resume ? "thread/resume" : "thread/start", { cwd: process.cwd(), ...(resume ? { threadId: resume } : {}) })
    this.id = result.thread?.id
    if (!this.id) throw new Error("Codex did not return a thread identity")
    this.resumable = true; this.model = result.model; this.effort = result.reasoningEffort
    this.models = []; let cursor
    do { const page = await this.peer.request("model/list", { ...(cursor ? { cursor } : {}) }); this.models.push(...page.data || []); cursor = page.nextCursor } while (cursor)
    this.catalog()
    this.commands = [
      { name: "compact", description: "Compact the current Codex thread", source: "native" },
      { name: "review", description: "Review uncommitted changes, or supply review instructions", input: { hint: "Optional review instructions" }, source: "native" },
    ]
    this.commandUpdate()
  }
  catalog() {
    this.configs = []
    if (this.models.length) this.configs.push(option("model", "Model", "model", this.model || "", this.models.map(model => ({ value: model.id || model.model, name: model.displayName || model.id || model.model }))))
    const model = this.models.find(model => (model.id || model.model) === this.model)
    const efforts = model?.supportedReasoningEfforts?.map(item => item.reasoningEffort)
    if (efforts?.length) this.configs.push(option("effort", "Reasoning", "thought_level", this.effort || model.defaultReasoningEffort || efforts[0], values(efforts)))
    this.configUpdate()
  }
  async prompt(text) {
    const done = this.begin()
    try {
      const command = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
      if (command?.[1] === "compact") {
        await this.peer.request("thread/compact/start", { threadId: this.id })
        return done
      }
      if (command?.[1] === "review") {
        const result = await this.peer.request("review/start", { threadId: this.id, delivery: "inline", target: command[2]?.trim() ? { type: "custom", instructions: command[2].trim() } : { type: "uncommittedChanges" } })
        this.turnId = result.turn?.id
        return done
      }
      if (command && !this.commands.some(entry => entry.name === command[1])) throw new Error(`/${command[1]} is a Codex terminal action, not a command supported in this chat. Use the conversation controls or terminal.`)
      const result = await this.peer.request("turn/start", { threadId: this.id, input: [{ type: "text", text }], ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}) })
      this.turnId = result.turn?.id
    } catch (error) { this.fail(error) }
    return done
  }
  async setConfig(id, value) {
    // App Server accepts model/effort on each turn. These are next-turn choices,
    // validated against its model catalog, not invented changes to remote config.
    if (id === "model") { this.model = value; this.effort = undefined }
    else if (id === "effort") this.effort = value
    else throw new Error("Unknown Codex setting")
    this.catalog()
  }
  async cancel() {
    if (!this.turnId) throw new Error("Codex has not acknowledged the turn yet")
    await this.peer.request("turn/interrupt", { threadId: this.id, turnId: this.turnId })
  }
  async event(event) {
    const p = event.params || {}, method = event.method || ""
    if (p.threadId && this.id && p.threadId !== this.id) return
    if (event.id !== undefined && method) {
      try {
        let result
        if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
          const decision = await this.permission(p.itemId, p.command || p.reason || "Approve agent operation", p, ["accept", "decline"])
          result = { decision }
        } else if (method === "item/tool/requestUserInput") {
          const properties = Object.fromEntries((p.questions || []).map(q => [q.id, { type: "string", title: q.header, description: q.question, ...(q.options?.length ? { enum: q.options.map(o => o.label) } : {}) }]))
          const answers = await this.form("Codex needs your input", properties)
          result = { answers: Object.fromEntries((p.questions || []).map(q => [q.id, { answers: answers?.[q.id] ? [answers[q.id]] : [] }])) }
        } else throw new Error(`Unsupported Codex request: ${method}`)
        this.peer.send({ jsonrpc: "2.0", id: event.id, result })
      } catch (error) { this.peer.send({ jsonrpc: "2.0", id: event.id, error: { code: -32601, message: errorText(error) } }) }
      return
    }
    if (method === "turn/started") this.turnId = p.turn?.id
    if (method === "item/agentMessage/delta") this.text(p.delta, false, p.itemId)
    if (/item\/reasoning\/(?:textDelta|summaryTextDelta)/.test(method)) this.text(p.delta, true, p.itemId)
    if (method === "turn/plan/updated") this.update({ sessionUpdate: "plan", entries: (p.plan || []).map(entry => ({ content: entry.step, status: entry.status === "inProgress" ? "in_progress" : entry.status })) })
    if (method === "item/started" || method === "item/completed") {
      const item = p.item || {}, completed = method === "item/completed"
      if (item.type === "commandExecution") this.tool(item.id, item.command || "Run command", item.status === "failed" ? "failed" : completed ? "completed" : "in_progress", { command: item.command, cwd: item.cwd }, item.aggregatedOutput ? [{ type: "content", content: { type: "text", text: item.aggregatedOutput } }] : undefined, { exitCode: item.exitCode })
      else if (item.type === "fileChange") this.tool(item.id, "Edit files", item.status === "failed" ? "failed" : completed ? "completed" : "in_progress", undefined, (item.changes || []).map(change => ({ type: "patch", path: change.path, patch: change.diff || "" })))
      else if (!["agentMessage", "reasoning", "userMessage", "plan"].includes(item.type)) this.tool(item.id, item.tool || item.type || "Tool", completed ? item.status === "failed" ? "failed" : "completed" : "in_progress", item.arguments, item.result ? [{ type: "content", content: { type: "text", text: textOf(item.result?.content) || JSON.stringify(item.result) } }] : undefined)
    }
    if (method === "item/commandExecution/outputDelta") this.update({ sessionUpdate: "tool_call_update", toolCallId: p.itemId, _meta: { outputDelta: p.delta } })
    if (method === "item/completed" && p.item?.type === "contextCompaction") this.finish()
    if (method === "turn/completed") {
      this.turnId = undefined
      if (p.turn?.status === "failed" || p.turn?.error) this.fail(new Error(p.turn?.error?.message || "Codex turn failed"))
      else this.finish(p.turn?.status === "interrupted")
    }
    if (method === "error" && !p.willRetry) this.fail(new Error(p.error?.message || p.message || "Codex failed"))
  }
}

export class ClaudeDriver extends Driver {
  async start(resume) {
    this.id = resume || randomUUID(); this.resumable = true; this.tasks = new Set(); this.blocks = new Map()
    this.peer = new Peer(this.executable, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--setting-sources", "user,project,local", resume ? `--resume=${resume}` : `--session-id=${this.id}`], value => this.event(value), { CLAUDE_CODE_SDK_READS_SESSION_STATE: "1" })
    this.peer.onFailure = error => this.fail(error)
    this.call = (method, params) => this.peer.request(method, params, "claude")
    const init = await this.call("initialize", { hooks: null })
    this.models = init.models || []
    this.configs = [option("model", "Model", "model", "", [{ value: "", name: "Account default" }, ...this.models.map(model => ({ value: model.value || model.id, name: model.displayName || model.name || model.value || model.id }))].filter(model => typeof model.value === "string")), option("mode", "Mode", "mode", "default", [{ value: "default", name: "Ask" }, { value: "plan", name: "Plan" }, { value: "acceptEdits", name: "Accept edits" }])]
    this.commands = (init.commands || []).map(command => ({ name: command.name, description: command.description || "", ...(command.argumentHint ? { input: { hint: command.argumentHint } } : {}) }))
    this.configUpdate(); this.commandUpdate()
  }
  async prompt(text) {
    const done = this.begin(); this.result = null; this.sessionState = undefined; this.message++; this.streamed = false; this.cancelled = false
    try { this.peer.send({ type: "user", session_id: this.id, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } }) } catch (error) { this.fail(error) }
    return done
  }
  async setConfig(id, value) {
    if (id === "model") await this.call("set_model", { model: value || null })
    else if (id === "mode") await this.call("set_permission_mode", { mode: value })
    else throw new Error("Unknown Claude setting")
    this.configs.find(option => option.id === id).currentValue = value; this.configUpdate()
  }
  async cancel() { this.cancelled = true; await this.call("interrupt") }
  settle() {
    if (!this.result || this.tasks.size || this.sessionState && this.sessionState !== "idle") return
    const result = this.result; this.result = null
    if (result.is_error) this.fail(new Error(result.errors?.join("\n") || result.result || "Claude turn failed"))
    else this.finish(this.cancelled)
    this.cancelled = false
  }
  async event(event) {
    if (event.type === "control_request") {
      const p = event.request || {}
      try {
        if (p.subtype !== "can_use_tool") throw new Error(`Unsupported Claude request: ${p.subtype}`)
        let result
        if (p.tool_name === "AskUserQuestion") {
          const props = Object.fromEntries((p.input?.questions || []).map((q, i) => [String(i), { type: q.multiSelect ? "array" : "string", title: q.header, description: q.question, ...(q.options ? q.multiSelect ? { items: { enum: q.options.map(o => o.label) } } : { enum: q.options.map(o => o.label) } : {}) }]))
          const answers = await this.form(p.title || "Claude needs your input", props)
          result = answers ? { behavior: "allow", updatedInput: { ...p.input, answers: Object.fromEntries(p.input.questions.map((q, i) => [q.question, Array.isArray(answers[String(i)]) ? answers[String(i)].join(", ") : answers[String(i)]])) } } : { behavior: "deny", message: "User dismissed the question" }
        } else {
          const decision = await this.permission(p.tool_use_id || event.request_id, p.title || p.tool_name, p.input)
          result = decision === "allow" ? { behavior: "allow", updatedInput: p.input } : { behavior: "deny", message: "User rejected the operation" }
        }
        this.peer.send({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: result } })
      } catch (error) { this.peer.send({ type: "control_response", response: { subtype: "error", request_id: event.request_id, error: errorText(error) } }) }
    }
    if (event.type === "stream_event") {
      const p = event.event || {}
      if (p.type === "message_start") { this.message++; this.streamed = false; this.blocks.clear() }
      if (p.type === "content_block_start" && p.content_block?.type === "tool_use") {
        this.blocks.set(p.index, { ...p.content_block, json: "" }); this.tool(p.content_block.id, p.content_block.name, "in_progress", p.content_block.input)
      }
      if (p.type === "content_block_delta") {
        if (p.delta?.type === "text_delta" || p.delta?.type === "thinking_delta") { this.streamed = true; this.text(p.delta.text || p.delta.thinking, p.delta.type === "thinking_delta", `claude-${this.message}-${p.index}`) }
        if (p.delta?.type === "input_json_delta" && this.blocks.has(p.index)) this.blocks.get(p.index).json += p.delta.partial_json
      }
      if (p.type === "content_block_stop" && this.blocks.has(p.index)) {
        const block = this.blocks.get(p.index)
        if (block.json) { try { this.tool(block.id, block.name, "in_progress", JSON.parse(block.json)) } catch { /* Final assistant message carries authoritative input. */ } }
      }
    }
    if (event.type === "assistant") {
      if (!this.streamed) this.text(textOf(event.message?.content), false, event.message?.id)
      for (const block of event.message?.content || []) if (block.type === "tool_use") this.tool(block.id, block.name, "in_progress", block.input)
    }
    if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) if (block.type === "tool_result") this.update({ sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: textOf(block.content) } }] })
    }
    if (event.type === "system") {
      if (event.subtype === "init") {
        if (event.session_id) this.id = event.session_id
        if (event.model && !this.configs[0]?.options.some(o => o.value === event.model)) this.configs[0]?.options.push({ value: event.model, name: event.model })
        if (event.model && this.configs[0]) this.configs[0].currentValue = event.model
        if (event.slash_commands) this.commands = [...new Map([...this.commands, ...event.slash_commands.map(name => ({ name, description: "" }))].map(command => [command.name, command])).values()]
        this.configUpdate(); this.commandUpdate()
      }
      if (event.subtype === "session_state_changed") { this.sessionState = event.state; this.settle() }
      if (event.subtype === "task_started" && ["local_agent", "local_workflow"].includes(event.task_type)) this.tasks.add(event.task_id)
      if (event.subtype === "task_notification") { this.tasks.delete(event.task_id); this.settle() }
      if (event.subtype === "task_updated" && ["completed", "failed", "cancelled", "stopped"].includes(event.patch?.status)) { this.tasks.delete(event.task_id); this.settle() }
    }
    if (event.type === "result") { this.result = event; this.settle() }
  }
}

export class OpenCodeDriver extends Driver {
  async start(resume) {
    this.password = randomBytes(32).toString("hex"); this.abort = new AbortController(); this.tools = new Map(); this.scanPending = new Set(["command.updated", "skill.updated"])
    this.scanned = new Promise(resolve => { this.finishScan = resolve })
    this.server = spawn(this.executable, ["serve", "--hostname=127.0.0.1", "--port=0"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env: { ...process.env, OPENCODE_PASSWORD: this.password, OPENCODE_SERVER_PASSWORD: this.password } })
    const url = await deadline(new Promise((resolve, reject) => {
      let output = ""
      const read = data => { output = (output + data.toString()).slice(-16000); const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]) }
      this.server.stdout.on("data", read); this.server.stderr.on("data", read)
      this.server.once("error", reject); this.server.once("exit", code => reject(new Error(`OpenCode server exited (${code})`)))
    }), 30000, "OpenCode startup")
    this.url = url
    const info = await this.http("GET", "/api/info")
    if (!String(info.version || info.data?.version || "").startsWith("2.")) throw new Error("Native command integration requires OpenCode v2. Update the remote OpenCode installation to use this connection.")
    await this.subscribe()
    const result = resume ? await this.http("GET", `/api/session/${encodeURIComponent(resume)}`) : await this.http("POST", "/api/session", { location: { directory: process.cwd() } })
    this.session = result.data || result; this.id = this.session.id; this.resumable = true
    if (!this.id) throw new Error("OpenCode did not return a session identity")
    await this.catalog(true)
    this.server.on("exit", () => { if (!this.abort.signal.aborted) this.fail(new Error("The OpenCode server exited")) })
  }
  async http(method, path, body) {
    const response = await fetch(this.url + path, { method, headers: { Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) })
    const text = await response.text(); let value
    try { value = text ? JSON.parse(text) : {} } catch { throw new Error("OpenCode returned an unsupported API response") }
    if (!response.ok) throw new Error(value.message || value.error?.message || `OpenCode request failed (${response.status})`)
    return value
  }
  async catalog(waitForScan = false) {
    if (this.catalogTask) return this.catalogTask
    const task = this.readCatalog(waitForScan)
    this.catalogTask = task
    try { await task } finally { if (this.catalogTask === task) this.catalogTask = null }
  }
  async readCatalog(waitForScan) {
    const location = `?location[directory]=${encodeURIComponent(process.cwd())}`
    const read = () => Promise.all([this.http("GET", "/api/command" + location), this.http("GET", "/api/model" + location), this.http("GET", "/api/agent" + location), this.http("GET", "/api/skill" + location)])
    let [commands, models, agents] = await read()
    if (waitForScan && (!commands.data?.length || !agents.data?.length)) {
      await deadline(this.scanned, 10000, "Project command discovery").catch(() => {})
      ;[commands, models, agents] = await read()
    }
    const session = await this.http("GET", `/api/session/${this.id}`)
    this.session = session.data || session
    this.commands = (commands.data || []).map(command => ({ name: command.name, description: command.description || "" }))
    if (!this.commands.some(command => command.name === "compact")) this.commands.push({ name: "compact", description: "Compact this conversation" })
    this.models = (models.data || []).filter(model => model.enabled !== false)
    if (!this.session.model) {
      const model = await this.http("GET", "/api/model/default" + location).catch(() => null)
      if (model?.data) this.defaultModel = { providerID: model.data.providerID, id: model.data.id }
    }
    const activeModel = this.session.model || this.defaultModel
    this.configs = []
    if (this.models.length) this.configs.push(option("model", "Model", "model", activeModel ? `${activeModel.providerID}/${activeModel.id}` : "", this.models.map(model => ({ value: `${model.providerID}/${model.id}`, name: model.name }))))
    const modes = (agents.data || []).filter(agent => !agent.hidden && agent.mode !== "subagent")
    if (modes.length) this.configs.push(option("mode", "Agent", "mode", this.session.agent || "", modes.map(agent => ({ value: agent.id, name: agent.name || agent.id }))))
    const model = this.models.find(model => `${model.providerID}/${model.id}` === this.configs.find(option => option.id === "model")?.currentValue)
    if (model?.variants?.length) this.configs.push(option("effort", "Reasoning", "thought_level", this.session.model?.variant || "", [{ value: "", name: "Default" }, ...model.variants.map(v => ({ value: v.id, name: v.name || v.id }))]))
    this.configUpdate(); this.commandUpdate()
  }
  async prompt(text) {
    const done = this.begin()
    this.commandIdleCheck = false
    try {
      await this.catalog()
      const command = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
      if (command?.[1] === "compact") { await this.http("POST", `/api/session/${this.id}/compact`, {}) }
      else if (command) {
        if (!this.commands.some(entry => entry.name === command[1])) throw new Error(`/${command[1]} is not a command exposed by OpenCode in this folder`)
        await this.http("POST", `/api/session/${this.id}/command`, { name: command[1], text: command[2] || "" })
        // A command can open a form or change settings without starting a turn.
        this.commandIdleCheck = true
        await this.checkCommandIdle()
      } else await this.http("POST", `/api/session/${this.id}/prompt`, { text })
    } catch (error) { this.fail(error) }
    return done
  }
  async checkCommandIdle() {
    if (!this.commandIdleCheck || !this.turn || this.questionCount) return
    const [active, forms] = await Promise.all([this.http("GET", "/api/session/active"), this.http("GET", `/api/session/${this.id}/form`)])
    const pending = forms.data || forms
    if (!this.questionCount && !(Array.isArray(pending) && pending.length) && !Object.prototype.hasOwnProperty.call(active.data || active, this.id)) this.finish()
  }
  async setConfig(id, value) {
    if (id === "mode") { await this.http("POST", `/api/session/${this.id}/agent`, { agent: value }); this.session.agent = value }
    else {
      const model = id === "model" ? (() => { const [providerID, ...parts] = value.split("/"); return { providerID, id: parts.join("/") } })() : { ...(this.session.model || this.defaultModel), ...(value ? { variant: value } : {}) }
      if (id === "effort" && !value) delete model.variant
      await this.http("POST", `/api/session/${this.id}/model`, { model }); this.session.model = model
    }
    await this.catalog()
  }
  async cancel() { await this.http("POST", `/api/session/${this.id}/interrupt`, {}) }
  async subscribe() {
    const response = await fetch(this.url + "/api/event", { headers: { Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`, Accept: "text/event-stream" }, signal: this.abort.signal })
    if (!response.ok || !response.body) throw new Error("OpenCode event subscription failed")
    this.stream = (async () => {
      const parse = sseReader(event => { void this.event(event).catch(error => this.fail(error)) }, error => this.fail(error))
      for await (const bytes of response.body) {
        parse(Buffer.from(bytes))
      }
      if (!this.abort.signal.aborted) throw new Error("OpenCode event stream ended")
    })().catch(error => { if (!this.abort.signal.aborted) this.fail(error) })
  }
  async event(event) {
    const p = event.data || {}
    if (event.location?.directory === process.cwd() && this.scanPending?.delete(event.type) && !this.scanPending.size) this.finishScan()
    if (["command.updated", "model.updated", "agent.updated", "skill.updated"].includes(event.type)) {
      if (this.id && !this.catalogTask && (!event.location || event.location.directory === process.cwd())) void this.catalog().catch(error => this.fail(error))
      return
    }
    const form = event.type === "form.created" ? p.form : undefined
    if (!this.id || (form?.sessionID || p.sessionID) !== this.id) return
    if (form) {
      const properties = Object.fromEntries((form.fields || []).filter(field => !field.hidden).map(field => [field.key, {
        title: field.title || field.key, description: field.description,
        type: field.type === "multiselect" ? "array" : field.type,
        ...(field.options?.length ? field.type === "multiselect" ? { items: { enum: field.options.map(option => option.value) } } : { oneOf: field.options.map(option => ({ const: option.value, title: option.label })) } : {}),
      }]))
      const answer = await this.form(form.title, properties, (form.fields || []).filter(field => field.required && !field.hidden).map(field => field.key))
      if (answer) await this.http("POST", `/api/session/${this.id}/form/${encodeURIComponent(form.id)}/reply`, { answer })
      else await this.http("DELETE", `/api/session/${this.id}/form/${encodeURIComponent(form.id)}`)
      await this.checkCommandIdle()
      return
    }
    if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") this.text(p.delta, event.type === "session.reasoning.delta", `${p.assistantMessageID || p.messageID || ""}:${p.ordinal ?? p.index ?? p.id ?? ""}`)
    if (event.type === "session.step.started") this.lastRetryError = null
    if (event.type === "session.retry.scheduled") {
      this.lastRetryError = errorText(p.error)
      this.update({ sessionUpdate: "notice", message: `Provider retry ${p.attempt}: ${this.lastRetryError}` })
    }
    if (event.type === "session.step.failed") this.lastRetryError = errorText(p.error)
    if (event.type === "session.compaction.ended") this.finish()
    if (event.type === "session.compaction.failed") this.fail(new Error(errorText(p.error)))
    if (event.type === "session.tool.input.started") { this.tools.set(p.id, { name: p.name }); this.tool(p.id, p.name, "in_progress") }
    if (event.type === "session.tool.called") { const tool = this.tools.get(p.id) || { name: p.name || "Tool" }; tool.input = p.input; this.tools.set(p.id, tool); this.tool(p.id, tool.name, "in_progress", p.input) }
    if (event.type === "session.tool.progress") {
      const tool = this.tools.get(p.id)
      if (tool) this.tool(p.id, tool.name, "in_progress", tool.input, undefined, p.metadata)
    }
    if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      const tool = this.tools.get(p.id) || { name: "Tool" }
      this.tool(p.id, tool.name, event.type.endsWith("failed") ? "failed" : "completed", tool.input, p.content ? p.content.filter(c => c.type === "text").map(c => ({ type: "content", content: c })) : p.error ? [{ type: "content", content: { type: "text", text: errorText(p.error) } }] : undefined, p.metadata)
      this.tools.delete(p.id)
    }
    if (event.type === "session.execution.succeeded") this.finish()
    if (event.type === "session.execution.interrupted") this.finish(true)
    if (event.type === "session.execution.failed") this.fail(new Error(errorText(p.error)))
    if (event.type === "permission.asked" || event.type === "session.permission.requested") {
      void (async () => {
        const choice = await this.permission(p.source?.id || p.id, p.message || p.action, { resources: p.resources }, ["once", "reject"])
        await this.http("POST", `/api/session/${this.id}/permission/${encodeURIComponent(p.id)}/reply`, { decision: choice })
      })().catch(error => this.fail(error))
    }
  }
  async close() {
    this.abort?.abort()
    if (this.server?.pid && this.server.exitCode === null) {
      const exited = new Promise(resolve => this.server.once("exit", resolve))
      try { process.kill(-this.server.pid, "SIGTERM") } catch {}
      try { await deadline(exited, 2500, "OpenCode shutdown") } catch {
        try { process.kill(-this.server.pid, "SIGKILL") } catch {}
        await deadline(exited, 2000, "OpenCode process cleanup")
      }
    }
  }
}

export function createHost(write, driverId, executable) {
  const classes = { pi: PiDriver, codex: CodexDriver, claude: ClaudeDriver, opencode: OpenCodeDriver }
  const DriverClass = classes[driverId]
  if (!DriverClass) throw new Error("Unsupported native agent")
  let driver, ready = false, closing = false, serial = 0, queue = [], cancelling = false
  const requests = new Map()
  const host = {
    questionGeneration: 0,
    update(update) { if (!ready) queue.push(update); else write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: driver.id, update } }) },
    ask(method, params) { const id = `question-${++serial}`; return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); write({ jsonrpc: "2.0", id, method, params }) }) },
    cancelQuestions() { host.questionGeneration++; for (const request of requests.values()) request.resolve({ action: "cancel", outcome: { outcome: "cancelled" } }); requests.clear() },
    async close() { if (closing) return; closing = true; host.cancelQuestions(); await driver?.close(); driver?.fail(new Error("The agent connection was closed")) },
    async handle(message) {
      if (!message.method && requests.has(String(message.id))) { const request = requests.get(String(message.id)); requests.delete(String(message.id)); message.error ? request.reject(new Error(errorText(message.error))) : request.resolve(message.result); return }
      try {
        let result = {}
        if (message.method === "initialize") result = { protocolVersion: 1, agentInfo: { name: { pi: "Pi", codex: "Codex", claude: "Claude Code", opencode: "OpenCode" }[driverId], version: "native" }, agentCapabilities: { loadSession: true }, authMethods: [] }
        else if (["session/new", "session/load"].includes(message.method)) {
          driver = new DriverClass(host, executable); await driver.start(message.params?.sessionId)
          result = { sessionId: driver.id, configOptions: driver.configs, _meta: { resumable: driver.resumable === true } }
        } else if (message.method === "session/prompt") {
          if (!ready || closing || cancelling) throw new Error("Agent session is not ready")
          result = await driver.prompt((message.params.prompt || []).map(part => part.text || "").join("\n"))
        } else if (message.method === "session/set_config_option") {
          const { configId, value } = message.params
          const config = driver.configs.find(option => option.id === configId)
          if (!config?.options?.some(option => option.value === value)) throw new Error("Choose a value offered by this agent")
          await driver.setConfig(configId, value); result = { configOptions: driver.configs }
        } else if (message.method === "session/cancel") {
          if (cancelling) return
          cancelling = true
          host.cancelQuestions()
          try { await driver?.cancel() } finally { cancelling = false }
        }
        else if (message.method === "session/close") { await host.close() }
        else throw new Error(`Unsupported request: ${message.method}`)
        if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, result })
        if (["session/new", "session/load"].includes(message.method)) { ready = true; const pending = queue; queue = []; pending.forEach(host.update); driver.commandUpdate() }
      } catch (error) {
        if (["session/new", "session/load"].includes(message.method)) await host.close()
        if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: errorText(error) } }); else host.update({ sessionUpdate: "session_error", message: errorText(error) })
      }
    },
  }
  return host
}

if (process.env.STILL_AGENT_DRIVER) {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Still's native bridge requires Node.js 20 or newer on the server")
  const write = value => process.stdout.write(JSON.stringify(value) + "\n")
  const host = createHost(write, process.env.STILL_AGENT_DRIVER, process.env.STILL_AGENT_EXECUTABLE)
  process.stdin.on("data", frameReader(value => { void host.handle(value) }, error => { write({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "session_error", message: errorText(error) } } }); void host.close() }))
  const shutdown = () => { void host.close().then(() => process.exit(0), error => { console.error(errorText(error)); process.exit(1) }) }
  process.stdin.on("end", shutdown)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown)
}
