import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const typescript = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const importSource = source => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
const todos = await importSource(await typescript("../src/agents/todos.ts"))

async function store(library) {
  const callbacks = new Map(), calls = { history: [], windows: [], changes: [] }
  const bridge = {
    agentHistory: async (id, before) => {
      calls.history.push({ id, before })
      const saved = library.rows.find(row => (row.conversationId || row.executionId) === id)
      const events = library.history?.[id] || saved.transcript
      const end = Math.min(before ?? events.length, events.length), start = Math.max(0, end - 200)
      return structuredClone({ executionId: saved.executionId, lastSequence: saved.lastSequence, transcript: events.slice(start, end), before: start || null, after: end < events.length ? end : null, total: events.length, latest: end === events.length })
    },
    agentHistoryWindow: async (id, before, after) => {
      calls.windows.push({ id, before, after })
      const saved = library.rows.find(row => (row.conversationId || row.executionId) === id)
      const events = library.history?.[id] || saved.transcript
      const start = after ?? Math.max(0, Math.min(before ?? events.length, events.length) - 200)
      const end = Math.min(start + 200, before ?? events.length)
      return structuredClone({ executionId: saved.executionId, lastSequence: saved.lastSequence, transcript: events.slice(start, end), before: start || null, after: end < events.length ? end : null, total: events.length, latest: end === events.length })
    },
    agentChangeHistory: async id => {
      calls.changes.push(id)
      return structuredClone({ executionId: id, changes: library.changeHistory?.[id] || [] })
    },
    subscribeToAgent: async (id, callback) => { callbacks.set(id, callback); return () => callbacks.delete(id) },
    agentSnapshot: async id => structuredClone(library.rows.find(row => row.executionId === id)),
  }
  const source = (await typescript("../src/session/agentThreads.ts")).replace(/^import .*;$/gm, "")
  const prelude = `const { bridge: nativeBridge, todos, library } = globalThis.__historyMemoryFixture;
const useSyncExternalStore=()=>{};
const requestAnimationFrame=()=>1;
const hostKey=s=>JSON.stringify([s.host,s.port,s.username]);
const normalizeFolder=s=>s;
const {reconcileTodos,restoreTodos,todoStaleReason}=todos;
const initializeAgentStorage=async()=>structuredClone(library);
const scheduleAgentSave=()=>{};
const discardAgentSave=()=>{};
const flushAgentSaves=async()=>{};
const useAgentStorage=()=>({});
`
  globalThis.__historyMemoryFixture = { bridge, todos, library }
  const module = await importSource(prelude + source + `\n// fixture ${Math.random()}`)
  delete globalThis.__historyMemoryFixture
  await module.loadAgentThreads()
  return { module, bridge, calls, callbacks }
}

function row(id, overrides = {}) {
  return {
    conversationId: id, executionId: id, localSessionId: "server", hostKey: "host", cwd: "/srv/project",
    agentId: "opencode", agentName: "OpenCode", state: "complete", persistent: true,
    lastSequence: 1, turnActive: false, configOptions: [], transcript: [{ sequence: 1, attemptId: id, type: "assistantChunk", text: "Initial response" }],
    meta: { id, hostKey: "host", folder: "/srv/project", title: id, pinned: false, draft: "Unsent local message", createdAt: 1, activityAt: 1, order: 1 },
    ...overrides,
  }
}

test("opening a 35-conversation library loads no bodies; scrolling merges bounded older/newer windows", async () => {
  const saved = Array.from({ length: 35 }, (_, index) => row(`saved-${index}`, { transcript: [], lastSequence: 7323, historyLoaded: false }))
  const events = Array.from({ length: 7323 }, (_, index) => ({ type: "assistantMessage", sequence: index + 1, attemptId: "saved-0", text: `Message ${index + 1}` }))
  const f = await store({ rows: saved, history: { "saved-0": events }, workspaces: {}, warnings: [] })
  assert.equal(f.calls.history.length, 0)
  assert.ok(f.module.useAgentThreads().every(row => row.transcript.length === 0))
  await f.module.loadAgentHistory("saved-0")
  assert.deepEqual(f.calls.history, [{ id: "saved-0", before: undefined }])
  const recent = f.module.useAgentThreads().find(row => row.executionId === "saved-0")
  assert.equal(recent.transcript.length, 200)
  assert.equal(recent.transcript.at(-1).sequence, 7323)
  assert.ok(f.module.useAgentThreads().filter(row => row.executionId !== "saved-0").every(row => row.transcript.length === 0))
  await f.module.loadEarlierAgentHistory("saved-0")
  assert.equal(recent.transcript.length, 400)
  assert.equal(recent.transcript[0].sequence, 6924)
  assert.equal(recent.transcript.at(-1).sequence, 7323)
  await f.module.loadEarlierAgentHistory("saved-0")
  assert.equal(recent.transcript.length, 400, "the scroll window must stay bounded")
  assert.equal(recent.transcript[0].sequence, 6724)
  assert.equal(recent.transcript.at(-1).sequence, 7123)
  assert.equal(recent.historyAfter, 7123)
  await f.module.loadLaterAgentHistory("saved-0")
  assert.equal(recent.transcript.length, 400)
  assert.equal(recent.transcript[0].sequence, 6924)
  assert.equal(recent.transcript.at(-1).sequence, 7323)
  assert.equal(recent.historyAfter, null)
  assert.equal(recent.meta.draft, "Unsent local message")
})

test("streamed output is bounded by bytes as well as event count, including a single endless message", async () => {
  const f = await store({ rows: [row("live", { transcript: [], lastSequence: 0 })], liveExecutions: ["live"], workspaces: {}, warnings: [] })
  const receive = f.callbacks.get("live")
  assert.equal(typeof receive, "function")
  for (let sequence = 1; sequence <= 4000; sequence++) receive({ sequence, attemptId: "live", type: "assistantChunk", text: "x".repeat(1024) })
  const current = f.module.useAgentThreads()[0]
  assert.ok(current.transcript.length <= 200)
  assert.ok(JSON.stringify(current.transcript).length < 513 * 1024)
  assert.ok(current.transcript.every(event => event.text.length <= 16 * 1024))
  assert.equal(current.lastSequence, 4000)
  assert.equal(current.historyTruncated, true)
  for (let sequence = 4001; sequence <= 5000; sequence++) receive({ sequence, attemptId: "live", type: "toolUpdate", toolCallId: `tool-${sequence}`, text: "x".repeat(4096) })
  assert.ok(current.transcript.length <= 200)
  assert.ok(JSON.stringify(current.transcript).length < 513 * 1024)
  assert.equal(current.lastSequence, 5000)
})

test("a stale disk page cannot overwrite a newer event, even if a snapshot replaced the row during the read", async () => {
  const saved = row("live", { historyLoaded: false, transcript: [], lastSequence: 0 })
  const f = await store({ rows: [saved], liveExecutions: ["live"], workspaces: {}, warnings: [] })
  let finish
  f.bridge.agentHistory = () => new Promise(resolve => { finish = resolve })
  const loading = f.module.loadAgentHistory("live")
  await f.module.refreshAgentThread("live")
  f.callbacks.get("live")({ type: "assistantChunk", attemptId: "live", sequence: 1, text: "New live output" })
  finish({ executionId: "live", lastSequence: 0, transcript: [], before: null, after: null, total: 0, latest: true })
  await loading
  const current = f.module.useAgentThreads()[0]
  assert.equal(current.transcript.at(-1).text, "New live output")
  assert.equal(current.historyLoaded, true)
  assert.equal(current.historyLoading, false)
})

test("history failures are visible and retryable without losing drafts or leaving loading stuck", async () => {
  const f = await store({ rows: [row("saved", { transcript: [], historyLoaded: false })], workspaces: {}, warnings: [] })
  f.bridge.agentHistory = async () => { throw new Error("Disk unavailable") }
  await assert.rejects(f.module.loadAgentHistory("saved"), /Disk unavailable/)
  let current = f.module.useAgentThreads()[0]
  assert.match(current.historyError, /Disk unavailable/)
  assert.equal(current.historyLoading, false)
  f.bridge.agentHistory = async () => ({ executionId: "saved", lastSequence: 1, transcript: [{ type: "assistantMessage", sequence: 1, text: "Recovered" }], before: null, after: null, total: 1, latest: true })
  await f.module.loadAgentHistory("saved")
  current = f.module.useAgentThreads()[0]
  assert.equal(current.historyError, "")
  assert.equal(current.historyLoading, false)
  assert.equal(current.transcript[0].text, "Recovered")
  assert.equal(current.meta.draft, "Unsent local message")
})

test("historical changes are indexed independently and live edits appear without another prompt", async () => {
  const indexed = [{ id: "old-tool:src/old.ts", path: "src/old.ts", toolCallId: "old-tool", outcome: "completed" }]
  const f = await store({ rows: [row("saved", { transcript: [], historyLoaded: false })], liveExecutions: ["saved"], changeHistory: { saved: indexed }, workspaces: {}, warnings: [] })
  await f.module.loadAgentChangeHistory("saved")
  await f.module.subscribeRemoteAgent("saved")
  const current = f.module.useAgentThreads()[0]
  assert.deepEqual(current.changeSummaries.map(item => item.path), ["src/old.ts"])
  f.callbacks.get("saved")({ type: "toolStart", sequence: 2, attemptId: "saved", toolCallId: "live-tool", toolKind: "edit", title: "Edit file", status: "in_progress", rawInput: { path: "src/live.ts" } })
  assert.deepEqual(current.changeSummaries.map(item => item.path), ["src/old.ts", "src/live.ts"])
  assert.equal(current.transcript.some(event => event.type === "userMessage"), false)
  f.callbacks.get("saved")({ type: "toolUpdate", sequence: 3, attemptId: "saved", toolCallId: "live-tool", status: "completed" })
  assert.equal(current.changeSummaries.find(item => item.path === "src/live.ts").outcome, "completed")
})
