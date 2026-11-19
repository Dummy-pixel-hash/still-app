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
  const callbacks = new Map()
  const calls = { pages: [], attaches: [], sends: [], metadata: [], shared: [], workspaces: [] }
  const visibilityListeners = new Set()
  const bridge = {
    agentLibrary: async () => structuredClone(library),
    agentAttach: async (_native, id) => {
      calls.attaches.push(id)
      return structuredClone(library.rows.find(row => row.executionId === id))
    },
    subscribeToAgent: async (id, callback) => { callbacks.set(id, callback); return () => callbacks.delete(id) },
    agentSnapshot: async id => structuredClone(library.rows.find(row => row.executionId === id)),
    agentSend: async (id, text) => { calls.sends.push({ id, text }) },
    agentSaveMetadata: async (id, meta) => calls.metadata.push({ id, meta }),
    agentSaveWorkspace: async (key, value) => calls.workspaces.push({ key, value }),
    subscribeToSession: async () => () => {},
  }
  const source = (await typescript("../src/session/agentThreads.ts")).replace(/^import .*;$/gm, "")
  // Compile the real session store, substituting only its external dependencies.
  const prelude = `const { bridge: nativeBridge, todos, library, visibilityListeners } = globalThis.__continuityStoreFixture;
 const document={visibilityState:'visible',addEventListener:(_name,fn)=>visibilityListeners.add(fn),removeEventListener:(_name,fn)=>visibilityListeners.delete(fn)};
const useSyncExternalStore=()=>{};
const hostKey=s=>JSON.stringify([s.host,s.port,s.username]);
const normalizeFolder=s=>s;
const {reconcileTodos,restoreTodos,todoStaleReason}=todos;
const initializeAgentStorage=async()=>structuredClone(library);
const scheduleAgentSave=()=>{};
const storedWorkspace=key=>library.workspaces[key];
const storedWorkspaces=()=>library.workspaces;
const saveAgentWorkspace=(key,value)=>{library.workspaces[key]=structuredClone(value)};
const sharedAccount=host=>storedWorkspace('shared-account:'+host);
const discardAgentSave=()=>{};
const flushAgentSaves=async()=>{};
const useAgentStorage=()=>({});
`
  globalThis.__continuityStoreFixture = { bridge, todos, library, visibilityListeners }
  const module = await importSource(prelude + source + `\n// fixture ${Math.random()}`)
  delete globalThis.__continuityStoreFixture
  await module.loadAgentThreads()
  return { module, bridge, calls, callbacks, visibilityListeners }
}

function row(id, overrides = {}) {
  return {
    conversationId: id, executionId: id, localSessionId: "server", hostKey: "host", cwd: "/srv/project",
    agentId: "opencode", agentName: "OpenCode", state: "complete", persistent: true, continuity: true,
    lastSequence: 1, turnActive: false, configOptions: [], transcript: [{ sequence: 1, attemptId: id, type: "assistantChunk", text: "Initial response" }],
    meta: { id, hostKey: "host", folder: "/srv/project", title: id, pinned: false, draft: "Unsent local message", createdAt: 1, activityAt: 1, order: 1 },
    ...overrides,
  }
}

test("remote discovery imports new identities and leaves live subscriptions and local drafts intact", async () => {
  const library = { rows: [row("existing")], liveExecutions: ["existing"], workspaces: {}, warnings: [] }
  const fixture = await store(library)
  fixture.bridge.agentRemoteLibrary = async (_native, after) => {
    fixture.calls.pages.push(after)
    if (!after) {
      if (!library.rows.some(row => row.executionId === "discovered")) library.rows.push(row("discovered"))
      return { protocolVersion: 4, serverAccountId: "account", rows: [{ executionId: "existing" }], warnings: [], next: "page-two" }
    }
    return { protocolVersion: 4, serverAccountId: "account", rows: [{ executionId: "discovered" }], warnings: [], next: null }
  }
  await fixture.module.syncRemoteAgentLibrary("native")
  assert.deepEqual(fixture.calls.pages, [undefined, "page-two"])
  assert.deepEqual(fixture.calls.attaches, ["discovered"])
  assert.equal(fixture.module.useAgentThreads().find(row => row.executionId === "existing").meta.draft, "Unsent local message")
  await fixture.module.syncRemoteAgentLibrary("native")
  assert.deepEqual(fixture.calls.attaches, ["discovered"], "periodic discovery must not invalidate a live subscription")
})

test("blocked migration does not stop healthy conversation discovery and preserves local drafts", async () => {
  const library = { rows: [row("blocked")], liveExecutions: ["blocked"], workspaces: {}, warnings: [] }
  library.rows[0].meta.pendingConfig = { model: "b" }
  const fixture = await store(library)
  fixture.bridge.agentRemoteLibrary = async () => {
    if (!library.rows.some(item => item.executionId === "healthy")) library.rows.push(row("healthy"))
    return { rows: [{ executionId: "healthy" }], blockedConversations: [{ conversationId: "blocked", executionId: "new-execution", reason: "Original cache was kept" }], warnings: [], next: null }
  }
  const result = await fixture.module.syncRemoteAgentLibrary("native")
  assert.equal(result.blockedConversations.length, 1)
  assert.deepEqual(fixture.calls.attaches, ["healthy"])
  const existing = fixture.module.useAgentThreads().find(item => item.executionId === "blocked")
  assert.equal(existing.meta.draft, "Unsent local message")
  assert.deepEqual(existing.meta.pendingConfig, { model: "b" })
  assert.equal(existing.transcript[0].text, "Initial response")
  assert.deepEqual(fixture.calls.sends, [])
  const again = await fixture.module.syncRemoteAgentLibrary("native")
  assert.equal(again.blockedConversations.length, 1)
})

test("discovery waits for catch-up rather than enabling writes on an initialization handshake", async () => {
  const library = { rows: [], liveExecutions: [], workspaces: {}, warnings: [] }
  const fixture = await store(library)
  fixture.bridge.agentRemoteLibrary = async () => {
    library.rows = [row("catchup", { state: "connecting" })]
    return { rows: [{ executionId: "catchup" }], next: null }
  }
  const originalSnapshot = fixture.bridge.agentSnapshot
  let triggered = false
  fixture.bridge.agentSnapshot = async id => {
    const result = await originalSnapshot(id)
    if (!triggered) {
      triggered = true
      setTimeout(() => {
        library.rows[0].state = "working"
        library.rows[0].lastSequence = 2
        fixture.callbacks.get(id)({ type: "threadState", sequence: 2, attemptId: id, state: "working", turnActive: false })
      }, 30)
    }
    return result
  }
  await fixture.module.syncRemoteAgentLibrary("native")
  assert.equal(fixture.module.useAgentThreads()[0].state, "working")
})

test("legacy discovered executions are visible without automatically replacing their existing controller", async () => {
  const library = { rows: [], liveExecutions: [], workspaces: {}, warnings: [] }
  const fixture = await store(library)
  fixture.bridge.agentRemoteLibrary = async () => {
    library.rows = [row("legacy", { continuity: false, remoteImported: true, resumable: true, agentSessionId: "saved-provider-session" })]
    return { rows: [{ executionId: "legacy" }], next: null }
  }
  await fixture.module.syncRemoteAgentLibrary("native")
  assert.equal(fixture.module.useAgentThreads().length, 1)
  assert.deepEqual(fixture.calls.attaches, [])
  assert.equal(fixture.module.canResumeAgentThread(fixture.module.useAgentThreads()[0]), true, "legacy resume requires an explicit user action and the native process guard")
  await assert.rejects(fixture.module.sendAgentMessage("legacy", "Never auto-send"), /not ready/)
})

test("sync refreshes newly confirmed resume identity without replacing a cached draft or attaching a legacy worker", async () => {
  const library = { rows: [row("legacy", { continuity: false, remoteImported: true, resumable: false })], liveExecutions: [], workspaces: {}, warnings: [] }
  const f = await store(library)
  f.bridge.agentRemoteLibrary = async () => {
    library.rows[0].agentSessionId = "confirmed-provider-session"
    library.rows[0].resumable = true
    return { rows: [{ executionId: "legacy" }], next: null }
  }
  await f.module.syncRemoteAgentLibrary("native")
  const current = f.module.useAgentThreads()[0]
  assert.equal(current.agentSessionId, "confirmed-provider-session")
  assert.equal(current.resumable, true)
  assert.equal(current.meta.draft, "Unsent local message")
  assert.equal(f.module.canResumeAgentThread(current), true)
  assert.deepEqual(f.calls.attaches, [])
  assert.deepEqual(f.calls.sends, [])
})

test("a competing device's accepted turn survives rejection of this device's draft", async () => {
  const library = { rows: [row("shared")], liveExecutions: ["shared"], workspaces: {}, warnings: [] }
  const fixture = await store(library)
  fixture.bridge.agentSend = async () => {
    library.rows[0].turnActive = true
    library.rows[0].state = "working"
    library.rows[0].lastSequence = 2
    library.rows[0].transcript.push({ sequence: 2, attemptId: "shared", type: "userMessage", text: "Message from the other device", messageId: "remote-message" })
    throw { code: "agent_prompt_rejected", message: "The agent is busy" }
  }
  await assert.rejects(fixture.module.sendAgentMessage("shared", "My unsent message"))
  const updated = fixture.module.useAgentThreads()[0]
  assert.equal(updated.turnActive, true)
  assert.equal(updated.meta.draft, "Unsent local message")
  assert.equal(updated.meta.submissionUnknown, false)
  assert.ok(updated.transcript.some(event => event.messageId === "remote-message"))
})

test("authoritative receipt reconciliation clears uncertainty even without a newer event counter", async () => {
  const library = { rows: [row("shared", { meta: { ...row("shared").meta, submissionUnknown: true } })], liveExecutions: [], workspaces: {}, warnings: [] }
  const fixture = await store(library)
  await fixture.module.refreshAgentThread("shared")
  assert.equal(fixture.module.useAgentThreads()[0].meta.submissionUnknown, false)
  assert.equal(fixture.module.useAgentThreads()[0].state, "complete")
})

test("cyclic remote pagination fails explicitly instead of looping forever", async () => {
  const fixture = await store({ rows: [], liveExecutions: [], workspaces: {}, warnings: [] })
  fixture.bridge.agentRemoteLibrary = async (_native, after) => ({ rows: [], next: after === "first" ? "second" : "first" })
  await assert.rejects(fixture.module.syncRemoteAgentLibrary("native"), /repeated page cursor/)
})

test("skipped legacy records are partial-sync diagnostics, not a failure of a healthy resumed conversation", async () => {
  const library = { rows: [row("healthy")], liveExecutions: ["healthy"], workspaces: {}, warnings: [] }
  const f = await store(library)
  const warning = "Execution legacy-v1: Legacy worker has no conversation/project/provider metadata"
  f.bridge.agentRemoteLibrary = async () => ({ rows: [{ executionId: "healthy" }], warnings: [warning], next: null })
  const result = await f.module.syncRemoteAgentLibrary("native")
  assert.deepEqual(result.warnings, [warning])
  assert.equal(result.conversations, 1)
  assert.equal(f.module.useAgentThreads()[0].meta.draft, "Unsent local message")
  assert.deepEqual(f.calls.attaches, [])
  assert.deepEqual(f.calls.sends, [])
})

test("a partial-sync watcher reports an informative status rather than a failed recovery", { timeout: 5000 }, async t => {
  const f = await store({ rows: [], liveExecutions: [], workspaces: {}, warnings: [] })
  t.after(() => f.module.stopRemoteAgentLibrary("native"))
  f.bridge.agentRemoteLibrary = async () => ({ rows: [], warnings: ["Execution legacy: missing metadata"], next: null })
  const observed = new Promise(resolve => f.module.watchRemoteAgentLibrary("native", resolve))
  try {
    const status = await observed
    assert.equal(status.message, "Conversations synced. 1 record needs review.")
    assert.equal(status.failed, false)
    assert.deepEqual(status.warnings, ["Execution legacy: missing metadata"])
    assert.deepEqual(status.legacyRecords, [])
  } finally { f.module.stopRemoteAgentLibrary("native") }
})

test("known legacy records stay out of the primary sync message and replay as structured details to a reopened panel", { timeout: 5000 }, async t => {
  const f = await store({ rows: [], liveExecutions: [], workspaces: {}, warnings: [] })
  t.after(() => f.module.stopRemoteAgentLibrary("native"))
  const legacyRecords = Array.from({ length: 77 }, (_, index) => ({ executionId: `old-${index}`, reason: "Incomplete historical metadata" }))
  f.bridge.agentRemoteLibrary = async () => ({ rows: [], warnings: [], legacyRecords, next: null })
  const status = await new Promise(resolve => f.module.watchRemoteAgentLibrary("native", resolve))
  assert.equal(status.message, "Conversations synced.")
  assert.equal(status.failed, false)
  assert.deepEqual(status.warnings, [])
  assert.deepEqual(status.legacyRecords, legacyRecords)
  let reopened
  const detach = f.module.watchRemoteAgentLibrary("native", value => { reopened = value })
  detach()
  assert.deepEqual(reopened, status, "a reopened panel immediately receives the last sync result without waiting for another poll")
})

test("structured legacy details are deduplicated when the server repeats them on paginated library pages", async () => {
  const f = await store({ rows: [], liveExecutions: [], workspaces: {}, warnings: [] })
  const legacy = { executionId: "old-worker", reason: "Incomplete historical metadata" }
  f.bridge.agentRemoteLibrary = async (_native, after) => ({ rows: [], warnings: [], legacyRecords: [legacy], next: after ? null : "page-two" })
  const result = await f.module.syncRemoteAgentLibrary("native")
  assert.deepEqual(result.legacyRecords, [legacy])
})

test("real account failures remain visible to sync listeners rather than becoming collapsed diagnostics", { timeout: 5000 }, async t => {
  const f = await store({ rows: [], liveExecutions: [], workspaces: {}, warnings: [] })
  t.after(() => f.module.stopRemoteAgentLibrary("native"))
  f.bridge.agentRemoteLibrary = async () => { throw new Error("Remote account identity changed") }
  const status = await new Promise(resolve => f.module.watchRemoteAgentLibrary("native", resolve))
  assert.equal(status.failed, true)
  assert.match(status.message, /account identity changed/)
  assert.deepEqual(status.legacyRecords, [])
})

test("account identity failures remain real sync failures and preserve the cached conversation", async () => {
  const f = await store({ rows: [row("healthy")], liveExecutions: ["healthy"], workspaces: {}, warnings: [] })
  f.bridge.agentRemoteLibrary = async () => { throw new Error("Remote account identity changed") }
  await assert.rejects(f.module.syncRemoteAgentLibrary("native"), /account identity changed/)
  assert.equal(f.module.useAgentThreads()[0].meta.draft, "Unsent local message")
  assert.deepEqual(f.calls.sends, [])
})

const sharedAccountId = "00000000-0000-4000-8000-000000000001"
function shared(id = "shared", values = {}) {
  return { serverAccountId: sharedAccountId, conversationId: id, executionId: id, generation: 1,
    revision: 1, catalogRevision: 1, fields: { title: 0, pinned: 0, archivedAt: 0, order: 0 },
    values: { title: "Server title", titleSource: "agent", pinned: false, archivedAt: null, order: 1, ...values },
    readThroughSeq: 0, conversationSeq: 10, projectId: "project" }
}
async function boundStore() {
  const library = { rows: [row("shared", { remoteCursor: 10 })], liveExecutions: [], workspaces: {}, warnings: [] }
  const fixture = await store(library)
  const canonical = shared()
  fixture.bridge.agentRemoteLibrary = async () => ({ protocolVersion: 4, catalogVersion: 1, hostKey: "host", serverAccountId: sharedAccountId,
    revision: 1, projects: [{ id: "project", cwd: "/srv/project", name: "Shared project", order: 1, revision: 0 }],
    rows: [{ conversationId: "shared", executionId: "shared", cwd: "/srv/project", protocolVersion: 4, shared: canonical }], warnings: [], next: null })
  await fixture.module.syncRemoteAgentLibrary("native")
  return { ...fixture, library, canonical }
}

test("remote organization converges without replacing a device's unsent draft", async () => {
  const f = await boundStore(), current = f.module.useAgentThreads()[0]
  assert.equal(current.meta.title, "Server title")
  assert.equal(current.meta.draft, "Unsent local message")
  assert.equal(f.module.sharedUnread(current), true)
  assert.equal(f.calls.shared.length, 0, "sync itself never marks background content read")
})

test("an empty old catalog title cannot erase an already known title, while explicit user clearing still works", async () => {
  const f = await boundStore(), current = f.module.useAgentThreads()[0]
  current.meta.title = "Remembered desktop title"
  f.canonical.values.title = ""; f.canonical.values.titleSource = "prompt"; f.canonical.revision++
  await f.module.syncRemoteAgentLibrary("native")
  assert.equal(current.meta.title, "Remembered desktop title")
  f.canonical.values.titleSource = "user"; f.canonical.revision++
  await f.module.syncRemoteAgentLibrary("native")
  assert.equal(current.meta.title, "")
})

test("an imported conversation with no recorded title is labelled saved rather than new", async () => {
  const f = await store({ rows: [row("legacy", { remoteImported: true, transcript: [], meta: { ...row("legacy").meta, title: "" } })], liveExecutions: [], workspaces: {}, warnings: [] })
  assert.equal(f.module.threadTitle(f.module.useAgentThreads()[0]), "Saved OpenCode conversation")
})

test("shared intents are saved natively before transmission and exclude local draft text", async () => {
  const f = await boundStore()
  f.bridge.agentSharedOperation = async (_native, input) => {
    f.calls.shared.push(input)
    assert.equal(f.calls.metadata.at(-1).meta.sharedPending[0].operationId, input.operationId)
    assert.equal(Object.hasOwn(input.patch, "draft"), false)
    return { ok: true, current: { ...f.canonical, revision: 2, values: { ...f.canonical.values, title: input.patch.title, titleSource: "user" }, fields: { ...f.canonical.fields, title: 1 } } }
  }
  f.module.updateThreadMeta("shared", { title: "My shared title", titleSource: "user", draft: "Device-only text" })
  await f.module.flushSharedChanges("shared")
  const current = f.module.useAgentThreads()[0]
  assert.equal(current.meta.title, "My shared title")
  assert.equal(current.meta.draft, "Device-only text")
  assert.equal(current.meta.sharedPending.length, 0)
})

test("a conflict keeps the typed edit and requires explicit rebasing against the new field revision", async () => {
  const f = await boundStore()
  f.bridge.agentSharedOperation = async (_native, input) => {
    f.calls.shared.push(input)
    if (f.calls.shared.length === 1) return { ok: false, code: "revisionConflict", current: { ...f.canonical, revision: 3,
      fields: { ...f.canonical.fields, title: 2 }, values: { ...f.canonical.values, title: "Other device title", titleSource: "user" } } }
    return { ok: true, current: { ...f.canonical, revision: 4, fields: { ...f.canonical.fields, title: 3 }, values: { ...f.canonical.values, title: input.patch.title, titleSource: "user" } } }
  }
  f.module.updateThreadMeta("shared", { title: "Retain this edit", titleSource: "user" })
  await f.module.flushSharedChanges("shared")
  assert.equal(f.module.useAgentThreads()[0].meta.sharedConflict, true)
  assert.equal(f.module.useAgentThreads()[0].meta.title, "Retain this edit")
  await f.module.flushSharedChanges("shared")
  assert.equal(f.calls.shared.length, 1, "background sync never retries a conflicting overwrite")
  await f.module.retrySharedChanges("shared")
  assert.equal(f.calls.shared[1].expectedFields.title, 2)
  assert.notEqual(f.calls.shared[1].operationId, f.calls.shared[0].operationId)
  assert.equal(f.module.useAgentThreads()[0].meta.sharedConflict, false)
})

test("a lost reply retains the same operation ID instead of creating a second mutation", async () => {
  const f = await boundStore()
  f.bridge.agentSharedOperation = async (_native, input) => {
    f.calls.shared.push(input)
    if (f.calls.shared.length === 1) throw new Error("Network disconnected after commit")
    return { ok: true, current: { ...f.canonical, revision: 2, fields: { ...f.canonical.fields, pinned: 1 }, values: { ...f.canonical.values, pinned: true } } }
  }
  f.module.updateThreadMeta("shared", { pinned: true })
  await f.module.flushSharedChanges("shared")
  await f.module.retrySharedChanges("shared")
  assert.equal(f.calls.shared.length, 2)
  assert.equal(f.calls.shared[0].operationId, f.calls.shared[1].operationId)
  assert.equal(f.module.useAgentThreads()[0].meta.draft, "Unsent local message")
})

test("only an explicitly viewed conversation advances the shared read watermark", async () => {
  const f = await boundStore()
  f.bridge.agentSharedOperation = async (_native, input) => {
    f.calls.shared.push(input)
    return { ok: true, current: { ...f.canonical, revision: 2, readThroughSeq: input.readThroughSeq } }
  }
  assert.equal(f.calls.shared.length, 0)
  f.module.markAgentThreadRead("shared")
  await f.module.flushSharedChanges("shared")
  assert.equal(f.calls.shared[0].kind, "read.advance")
  assert.equal(f.calls.shared[0].readThroughSeq, 10)
  assert.equal(f.module.sharedUnread(f.module.useAgentThreads()[0]), false)
})

test("a resumed execution waits for its new shared generation before queuing read updates", async () => {
  const f = await boundStore(), current = f.module.useAgentThreads()[0]
  current.meta.shared.executionId = "retired-execution"
  f.module.markAgentThreadRead("shared")
  assert.equal(current.meta.sharedPending?.length || 0, 0)
  assert.deepEqual(f.calls.shared, [])
})

test("a shared tombstone hides remote work without discarding a local draft or allowing a send", async () => {
  const f = await boundStore()
  f.bridge.agentRemoteLibrary = async () => ({ protocolVersion: 4, catalogVersion: 1, hostKey: "host", serverAccountId: sharedAccountId,
    revision: 2, rows: [], projects: [], tombstones: ["shared"], warnings: [], next: null })
  await f.module.syncRemoteAgentLibrary("native")
  const current = f.module.useAgentThreads()[0]
  assert.equal(current.meta.sharedDeleted, true)
  assert.equal(current.meta.draft, "Unsent local message")
  await assert.rejects(f.module.sendAgentMessage("shared", "Must not send"), /not ready/)
  f.module.updateThreadMeta("shared", { draft: "" })
  assert.equal(f.module.useAgentThreads().length, 0)
})

test("hiding a sync panel does not stop the account's foreground discovery", async () => {
  const f = await boundStore()
  const original = f.bridge.agentRemoteLibrary
  let reads = 0
  f.bridge.agentRemoteLibrary = async (...args) => { reads++; return original(...args) }
  const detachPanel = f.module.watchRemoteAgentLibrary("native", () => {})
  try {
    await f.module.syncRemoteAgentLibrary("native")
    detachPanel()
    const before = reads
    for (const wake of f.visibilityListeners) wake()
    await f.module.syncRemoteAgentLibrary("native")
    assert.ok(reads > before)
    assert.equal(f.visibilityListeners.size, 1)
  } finally { f.module.stopRemoteAgentLibrary("native") }
  assert.equal(f.visibilityListeners.size, 0)
})

test("a project edit survives a lost reply and reconciles with its original operation ID on the next sync", async () => {
  const f = await boundStore()
  f.bridge.agentSharedOperation = async (_native, input) => { f.calls.shared.push(input); throw new Error("Lost reply") }
  await assert.rejects(f.module.updateSharedProject({ host: "host", folder: "/srv/project" }, { name: "My saved project name" }), /Lost reply/)
  const operation = f.calls.shared[0]
  f.bridge.agentSharedOperation = async (_native, input) => {
    f.calls.shared.push(input)
    return { ok: true, project: { id: "project", cwd: "/srv/project", name: "My saved project name", order: 1, revision: 2 } }
  }
  await f.module.syncRemoteAgentLibrary("native")
  assert.equal(f.calls.shared[1].operationId, operation.operationId)
  assert.equal(f.library.workspaces[`shared-project-intent:${sharedAccountId}:project`].resolved, true)
  assert.equal(f.module.useAgentThreads()[0].meta.draft, "Unsent local message")
})
