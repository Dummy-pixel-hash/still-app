import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverLibrary, executionLineage, mutateSharedLibrary, recordSharedWorker, registerSharedProject, reserveSharedChildSlot, sharedLibrary } from "../src-tauri/agent-host/shared-library.mjs"

const source = fileURLToPath(new URL("../src-tauri/agent-host/shared-library.mjs", import.meta.url))
async function fixture(t, modifiedAt, overrides = {}) {
  const home = await mkdtemp("/tmp/opencode/still-shared-library-")
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, ".local/state/still/agents/execution-a")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const worker = { version: 4, executionId: "execution-a", conversationId: "conversation-a", agentId: "opencode", cwd: "/srv/project", eventIndex: 10, title: "Initial task", titleSource: "prompt", ended: false, closed: false, busy: false, sessionResult: { sessionId: "original-provider-session", _meta: { resumable: true } }, ...overrides }
  const save = async values => writeFile(join(directory, "state.json"), JSON.stringify({ ...worker, ...values }), { mode: 0o600 })
  await save({})
  if (modifiedAt !== undefined) await utimes(join(directory, "state.json"), modifiedAt / 1000, modifiedAt / 1000)
  const page = sharedLibrary(home)
  const row = page.rows[0]
  const operation = (id, patch) => ({ kind: "organization.patch", operationId: id, serverAccountId: page.serverAccountId,
    expectedCatalogRevision: page.revision, conversationId: row.conversationId, executionId: row.executionId,
    expectedGeneration: 1, cwd: row.cwd, expectedFields: Object.fromEntries(Object.keys(patch).map(key => [key, row.shared.fields[key]])), patch })
  return { home, directory, worker, page, row, operation, save }
}

function rpc(home, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [source, "shared-call"], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", bytes => { stdout += bytes })
    child.stderr.on("data", bytes => { stderr += bytes })
    child.on("error", reject)
    child.on("exit", code => {
      if (code) reject(new Error(stderr))
      else { try { resolve(JSON.parse(stdout.split("STILL_SHARED:")[1])) } catch (error) { reject(error) } }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

test("shared organization is account-owned and retained after worker discovery disappears", async t => {
  const f = await fixture(t)
  const changed = mutateSharedLibrary(f.home, f.operation("rename", { title: "A shared name", pinned: true }))
  assert.equal(changed.ok, true)
  assert.equal(changed.current.values.titleSource, "user")
  await unlink(join(f.directory, "state.json"))
  const next = sharedLibrary(f.home)
  assert.equal(next.rows[0].shared.values.title, "A shared name")
  assert.equal(next.rows[0].shared.values.pinned, true)
  assert.equal(next.serverAccountId, f.page.serverAccountId)
})

test("filesystem timestamps produce integer millisecond metadata accepted by native storage", async t => {
  const f = await fixture(t, 1730000000123.456)
  const modifiedAt = (await stat(join(f.directory, "state.json"))).mtimeMs
  assert.equal(Number.isInteger(modifiedAt), false, "exercise a real sub-millisecond filesystem timestamp")
  const page = await rpc(f.home, { method: "list" })
  assert.equal(page.rows[0].activityAt, Math.trunc(modifiedAt))
  assert.equal(page.rows[0].shared.values.order, Math.trunc(modifiedAt))
  assert.ok(Number.isSafeInteger(page.rows[0].shared.values.order))
})

test("legacy fractional catalog orders and lost-reply receipts project safely without rewriting originals", async t => {
  const f = await fixture(t), input = f.operation("legacy-receipt", { pinned: true })
  mutateSharedLibrary(f.home, input)
  const file = join(f.home, ".local/state/still/catalog-v1/state.json")
  const state = JSON.parse(await readFile(file, "utf8")), order = 1730000000123.456
  state.conversations["conversation-a"].values.order = order
  state.receipts[0].result.current.values.order = order
  const original = JSON.stringify(state)
  await writeFile(file, original, { mode: 0o600 })
  await unlink(join(f.directory, "state.json"))
  const page = await rpc(f.home, { method: "list" })
  const replayed = await rpc(f.home, { method: "mutate", input })
  assert.equal(page.rows[0].shared.values.order, Math.trunc(order))
  assert.equal(replayed.current.values.order, Math.trunc(order))
  assert.equal(replayed.current.values.pinned, true)
  assert.equal(replayed.current.serverAccountId, f.page.serverAccountId)
  assert.equal(replayed.current.executionId, "execution-a")
  assert.deepEqual(replayed.current.fields, state.receipts[0].result.current.fields)
  assert.equal(await readFile(file, "utf8"), original, "compatibility projection preserves the catalog and receipt identities")
})

test("order compatibility never coerces invalid values or replaces the original catalog", async t => {
  const f = await fixture(t), file = join(f.home, ".local/state/still/catalog-v1/state.json")
  const state = JSON.parse(await readFile(file, "utf8"))
  for (const order of ["1730000000123.456", -1, Number.MAX_SAFE_INTEGER + 1, null]) {
    state.conversations["conversation-a"].values.order = order
    const original = JSON.stringify(state)
    await writeFile(file, original, { mode: 0o600 })
    assert.throws(() => sharedLibrary(f.home), /Invalid shared timestamp/)
    assert.equal(await readFile(file, "utf8"), original)
  }
})

test("legacy Gemini resume support follows its real load-session capability without inventing support for wrappers", async t => {
  const f = await fixture(t)
  const direct = { agentId: "gemini", initializeResult: { agentCapabilities: { loadSession: true } }, sessionResult: { sessionId: "saved-gemini-session" } }
  await f.save(direct)
  assert.equal(discoverLibrary(f.home).rows[0].resumable, true)
  await f.save({ ...direct, sessionResult: { sessionId: "saved-gemini-session", _meta: { resumable: false } } })
  assert.equal(discoverLibrary(f.home).rows[0].resumable, false)
  await f.save({ ...direct, agentId: "opencode" })
  assert.equal(discoverLibrary(f.home).rows[0].resumable, false)
  await f.save({ ...direct, sessionResult: {} })
  assert.equal(discoverLibrary(f.home).rows[0].resumable, false)
})

const legacyFixture = t => fixture(t, undefined, { version: 3, title: undefined, titleSource: undefined })
const titleFrame = (index, title) => JSON.stringify({ jsonrpc: "2.0", method: "_still/chat_title_changed", params: { title }, _still: { index } }) + "\n"

test("legacy titles are recovered from complete worker title events without modifying the original journal", async t => {
  const f = await legacyFixture(t), file = join(f.directory, "events.jsonl")
  const original = titleFrame(1, "First task title") + JSON.stringify({ method: "session/update", params: { title: "Not a conversation title" } }) + "\n" + titleFrame(3, "Restore the real chat title")
  await writeFile(file, original, { mode: 0o600 })
  const state = await readFile(join(f.directory, "state.json"), "utf8")
  const page = sharedLibrary(f.home)
  assert.equal(page.rows[0].shared.values.title, "Restore the real chat title")
  assert.equal(page.rows[0].shared.values.titleSource, "agent")
  assert.equal(await readFile(file, "utf8"), original)
  assert.equal(await readFile(join(f.directory, "state.json"), "utf8"), state)
  const revision = page.revision
  assert.equal(sharedLibrary(f.home).revision, revision, "unchanged journals do not rewrite the catalog on every poll")
})

test("legacy title indexing waits for complete UTF-8 records and never overwrites a user rename", async t => {
  const f = await legacyFixture(t), file = join(f.directory, "events.jsonl")
  const bytes = Buffer.from(titleFrame(2, "修复会话名称 🔧")), split = bytes.indexOf(Buffer.from("🔧")) + 2
  await writeFile(file, bytes.subarray(0, split), { mode: 0o600 })
  assert.equal(sharedLibrary(f.home).rows[0].shared.values.title, "")
  await appendFile(file, bytes.subarray(split))
  const current = sharedLibrary(f.home).rows[0].shared
  assert.equal(current.values.title, "修复会话名称 🔧")
  mutateSharedLibrary(f.home, { ...f.operation("manual-name", { title: "My chosen name" }), expectedFields: { title: current.fields.title } })
  await appendFile(file, titleFrame(4, "Later agent suggestion"))
  assert.equal(sharedLibrary(f.home).rows[0].shared.values.title, "My chosen name")
})

test("large legacy journals are indexed incrementally without copying transcript payloads into the catalog", async t => {
  const f = await legacyFixture(t), file = join(f.directory, "events.jsonl")
  await writeFile(file, 'BEGIN_PRIVATE_TRANSCRIPT' + "x".repeat(9 * 1024 * 1024) + '\n' + titleFrame(3, "Title after a large tool result"), { mode: 0o600 })
  assert.equal(sharedLibrary(f.home).rows[0].shared.values.title, "")
  assert.equal(sharedLibrary(f.home).rows[0].shared.values.title, "Title after a large tool result")
  const catalog = await readFile(join(f.home, ".local/state/still/catalog-v1/state.json"), "utf8")
  assert.equal(catalog.includes("BEGIN_PRIVATE_TRANSCRIPT"), false)
  assert.ok(catalog.length < 32768)
})

test("unsafe title journals cannot hide a valid conversation or import another file's title", async t => {
  const f = await legacyFixture(t)
  const outside = join(f.home, "unrelated-title.jsonl")
  await writeFile(outside, titleFrame(1, "Do not import this title"), { mode: 0o600 })
  await symlink(outside, join(f.directory, "events.jsonl"))
  const page = sharedLibrary(f.home)
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].shared.values.title, "")
  assert.equal(page.warnings.length, 1)
})

test("a resumed generation can recover its predecessor's missing title without blocking later current titles", async t => {
  const f = await legacyFixture(t)
  const next = join(f.home, ".local/state/still/agents/execution-b")
  await mkdir(next, { mode: 0o700 })
  const worker = { ...f.worker, version: 4, executionId: "execution-b", title: "", titleRevision: 0,
    replacesExecutionId: "execution-a", replacesAgentSessionId: "original-provider-session" }
  await writeFile(join(next, "state.json"), JSON.stringify(worker), { mode: 0o600 })
  assert.equal(sharedLibrary(f.home).rows[0].executionId, "execution-b")
  await writeFile(join(f.directory, "events.jsonl"), titleFrame(70, "Original desktop title"), { mode: 0o600 })
  assert.equal(sharedLibrary(f.home).rows[0].shared.values.title, "Original desktop title")
  await writeFile(join(next, "state.json"), JSON.stringify({ ...worker, title: "Current task title", titleSource: "agent", titleRevision: 1 }), { mode: 0o600 })
  assert.equal(sharedLibrary(f.home).rows[0].shared.values.title, "Current task title")
})

test("unidentifiable old records are skipped without deleting them or hiding healthy titled conversations", async t => {
  const f = await fixture(t)
  const directory = join(f.home, ".local/state/still/agents/legacy-v1")
  await mkdir(directory, { mode: 0o700 })
  const original = JSON.stringify({ version: 1, executionId: "legacy-v1", sessionResult: { sessionId: "old-session" } })
  await writeFile(join(directory, "state.json"), original, { mode: 0o600 })
  const page = sharedLibrary(f.home)
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].shared.values.title, "Initial task")
  assert.deepEqual(page.warnings, [])
  assert.equal(page.legacyRecords.length, 1)
  assert.equal(page.legacyRecords[0].executionId, "legacy-v1")
  assert.match(page.legacyRecords[0].reason, /Legacy worker.*metadata/)
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), original)
})

test("an identity mismatch is a warning, never a harmless legacy notice", async t => {
  const f = await fixture(t), directory = join(f.home, ".local/state/still/agents/legacy-wrong-id")
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, executionId: "another-execution" }), { mode: 0o600 })
  const page = sharedLibrary(f.home)
  assert.equal(page.warnings.length, 1)
  assert.deepEqual(page.legacyRecords, [])
  assert.equal(page.rows.length, 1)
})

test("informational legacy classification does not bypass the shared project removal guard", async t => {
  const f = await fixture(t), project = registerSharedProject(f.home, "/srv/empty")
  const directory = join(f.home, ".local/state/still/agents/legacy-unscoped")
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, "state.json"), JSON.stringify({ version: 1, executionId: "legacy-unscoped" }), { mode: 0o600 })
  assert.throws(() => mutateSharedLibrary(f.home, { kind: "project.delete", operationId: "do-not-infer-empty", serverAccountId: f.page.serverAccountId,
    expectedCatalogRevision: f.page.revision, projectId: project.id, cwd: project.cwd, expectedRevision: project.revision }), /records need recovery/)
})

test("an incomplete worker state cannot remove a known catalog conversation or invent worker death", async t => {
  const f = await fixture(t)
  await unlink(join(f.directory, "state.json"))
  const page = sharedLibrary(f.home)
  assert.deepEqual(page.warnings, [])
  assert.deepEqual(page.incompleteExecutions, ["execution-a"])
  assert.equal(page.rows[0].executionId, "execution-a")
  assert.equal(page.rows[0].agentSessionId, "original-provider-session")
  assert.equal(page.rows[0].shared.values.title, "Initial task")
  assert.equal(page.rows[0].available, true, "missing state alone is not proof that the previously observed worker died")
  await assert.rejects(stat(join(f.directory, "state.json")), { code: "ENOENT" })
})

test("a missing recovery predecessor stays a real warning rather than bypassing generation verification", async t => {
  const f = await fixture(t), directory = join(f.home, ".local/state/still/agents/execution-unproved")
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, "state.json"), JSON.stringify({ ...f.worker, executionId: "execution-unproved",
    replacesExecutionId: "missing-predecessor", replacesAgentSessionId: "original-provider-session" }), { mode: 0o600 })
  const page = sharedLibrary(f.home)
  assert.equal(page.warnings.length, 1)
  assert.deepEqual(page.incompleteExecutions, [])
  assert.equal(page.rows[0].executionId, "execution-a")
  assert.equal(page.rows[0].shared.generation, 1)
})

test("distinct field changes merge, conflicting edits preserve the authoritative value", async t => {
  const f = await fixture(t)
  assert.equal(mutateSharedLibrary(f.home, f.operation("rename", { title: "Desktop title" })).ok, true)
  assert.equal(mutateSharedLibrary(f.home, f.operation("pin", { pinned: true })).ok, true)
  const conflict = mutateSharedLibrary(f.home, f.operation("phone-rename", { title: "Phone title" }))
  assert.equal(conflict.code, "revisionConflict")
  assert.equal(conflict.current.values.title, "Desktop title")
  assert.equal(conflict.current.values.pinned, true)
})

test("kernel locking serializes independent SSH processes without losing either field", async t => {
  const f = await fixture(t)
  const replies = await Promise.all([
    rpc(f.home, { method: "mutate", input: f.operation("desktop-process", { title: "From desktop" }) }),
    rpc(f.home, { method: "mutate", input: f.operation("phone-process", { pinned: true }) }),
  ])
  assert.ok(replies.every(reply => reply.ok))
  const current = sharedLibrary(f.home).rows[0].shared.values
  assert.equal(current.title, "From desktop")
  assert.equal(current.pinned, true)
})

test("durable receipts reconcile lost replies and reject reused identities with changed input", async t => {
  const f = await fixture(t), input = f.operation("lost-reply", { pinned: true })
  const first = await rpc(f.home, { method: "mutate", input })
  const replayed = await rpc(f.home, { method: "mutate", input })
  assert.deepEqual(replayed, first)
  await assert.rejects(rpc(f.home, { method: "mutate", input: { ...input, patch: { pinned: false } } }), /different payload/)
})

test("read watermarks merge with max and cannot mark unseen future events as read", async t => {
  const f = await fixture(t)
  const base = { ...f.operation("read-a", {}), kind: "read.advance", readThroughSeq: 8 }
  assert.equal(mutateSharedLibrary(f.home, base).current.readThroughSeq, 8)
  assert.equal(mutateSharedLibrary(f.home, { ...base, operationId: "read-b", readThroughSeq: 3 }).current.readThroughSeq, 8)
  assert.throws(() => mutateSharedLibrary(f.home, { ...base, operationId: "future", readThroughSeq: 11 }), /outside the observed/)
})

test("private fields, foreign accounts, and stale execution generations cannot mutate shared data", async t => {
  const f = await fixture(t)
  assert.throws(() => mutateSharedLibrary(f.home, f.operation("draft", { draft: "local secret" })), /drafts and credentials/)
  assert.throws(() => mutateSharedLibrary(f.home, { ...f.operation("foreign", { pinned: true }), serverAccountId: "another-account" }), /different remote account/)
  assert.throws(() => mutateSharedLibrary(f.home, { ...f.operation("old-generation", { pinned: true }), expectedGeneration: 0 }), /execution generation changed/)
  assert.throws(() => mutateSharedLibrary(f.home, { ...f.operation("valid", { pinned: true }), operationId: "__proto__" }), /Invalid shared operation/)
})

test("user titles survive automatic worker suggestions and ended work remains discoverable", async t => {
  const f = await fixture(t)
  mutateSharedLibrary(f.home, f.operation("human-title", { title: "Keep my title" }))
  await f.save({ title: "New automatic title", titleSource: "agent", ended: true, eventIndex: 20 })
  recordSharedWorker(f.home, "execution-a")
  const current = sharedLibrary(f.home).rows[0]
  assert.equal(current.shared.values.title, "Keep my title")
  assert.equal(current.available, false)
  assert.equal(current.shared.conversationSeq, 20)
})

test("shared project edits use revisions and tombstones prevent resurrection", async t => {
  const f = await fixture(t), project = f.page.projects[0]
  const result = mutateSharedLibrary(f.home, { kind: "project.patch", operationId: "project-name", serverAccountId: f.page.serverAccountId,
    expectedCatalogRevision: f.page.revision, projectId: project.id, cwd: project.cwd, expectedRevision: project.revision, patch: { name: "Shared project" } })
  assert.equal(result.project.name, "Shared project")
  assert.throws(() => mutateSharedLibrary(f.home, { ...f.operation("delete-active", {}), kind: "conversation.delete", expectedRevision: f.row.shared.revision }), /Close this execution/)
  await f.save({ closed: true })
  const page = sharedLibrary(f.home), current = page.rows[0]
  const deleted = mutateSharedLibrary(f.home, { ...f.operation("delete-idle", {}), kind: "conversation.delete", expectedRevision: current.shared.revision })
  assert.equal(deleted.ok, true)
  assert.deepEqual(recordSharedWorker(f.home, "execution-a"), { deleted: true })
  const after = sharedLibrary(f.home)
  assert.equal(after.rows.length, 0)
  assert.deepEqual(after.tombstones, ["conversation-a"])
})

test("a corrupt catalog fails closed rather than replacing existing shared state", async t => {
  const f = await fixture(t), file = join(f.home, ".local/state/still/catalog-v1/state.json")
  await writeFile(file, "{corrupt", { mode: 0o600 })
  assert.throws(() => sharedLibrary(f.home))
  assert.equal(await readFile(file, "utf8"), "{corrupt")
})

test("empty verified projects have durable names and one atomic account-local order", async t => {
  const f = await fixture(t)
  registerSharedProject(f.home, "/srv/empty-a")
  registerSharedProject(f.home, "/srv/empty-b")
  const page = sharedLibrary(f.home), order = [...page.projects].reverse().map(project => ({ id: project.id, revision: project.revision }))
  const input = { kind: "project.reorder", operationId: "reorder", serverAccountId: page.serverAccountId, expectedCatalogRevision: page.revision, order }
  const result = mutateSharedLibrary(f.home, input)
  assert.equal(result.ok, true)
  assert.deepEqual([...result.projects].sort((a, b) => b.order - a.order).map(project => project.id), order.map(project => project.id))
  const conflict = mutateSharedLibrary(f.home, { ...input, operationId: "stale-reorder" })
  assert.equal(conflict.code, "revisionConflict")
})

test("explicit same-provider recovery advances one execution generation while preserving organization and read cursors", async t => {
  const f = await fixture(t)
  mutateSharedLibrary(f.home, f.operation("pin", { pinned: true }))
  mutateSharedLibrary(f.home, { ...f.operation("read", {}), kind: "read.advance", readThroughSeq: 8 })
  await f.save({ closed: true })
  const next = join(f.home, ".local/state/still/agents/execution-b")
  await mkdir(next, { mode: 0o700 })
  await writeFile(join(next, "state.json"), JSON.stringify({ ...f.worker, executionId: "execution-b", eventIndex: 3,
    replacesExecutionId: "execution-a", replacesAgentSessionId: "original-provider-session" }), { mode: 0o600 })
  const current = sharedLibrary(f.home).rows[0]
  assert.equal(current.executionId, "execution-b")
  assert.equal(current.shared.generation, 2)
  assert.equal(current.shared.executionOffset, 10)
  assert.equal(current.shared.conversationSeq, 13)
  assert.equal(current.shared.readThroughSeq, 8)
  assert.equal(current.shared.values.pinned, true)
  assert.equal(sharedLibrary(f.home).rows[0].shared.generation, 2, "old worker discovery cannot rewind the selected generation")
})

test("lineage proves a multi-hop migration, is absent without one, and is bounded and cycle-safe", async t => {
  const f = await fixture(t)
  assert.equal("lineage" in f.row, false, "no migration means no lineage field")
  const session = "original-provider-session"
  for (const [id, replaces] of [["execution-b", "execution-a"], ["execution-c", "execution-b"]]) {
    const directory = join(f.home, ".local/state/still/agents", id)
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, "state.json"), JSON.stringify({ ...f.worker, executionId: id, replacesExecutionId: replaces, replacesAgentSessionId: session }), { mode: 0o600 })
    assert.equal(sharedLibrary(f.home).rows[0].executionId, id)
  }
  const row = sharedLibrary(f.home).rows[0]
  assert.deepEqual(row.lineage, [{ executionId: "execution-b", agentSessionId: session }, { executionId: "execution-a", agentSessionId: session }])
  const chain = { executionId: "n0", executions: {} }
  for (let i = 0; i < 100; i++) chain.executions[`n${i}`] = { executionId: `n${i}`, replacesExecutionId: `n${i + 1}`, agentSessionId: "s" }
  assert.equal(executionLineage(chain).length, 64)
  const loop = { executionId: "x", executions: { x: { replacesExecutionId: "y" }, y: { replacesExecutionId: "x" } } }
  assert.deepEqual(executionLineage(loop).map(entry => entry.executionId), ["y"])
})

test("human and model-created children use the same account-serialized capacity boundary", async t => {
  const f = await fixture(t)
  for (const id of ["human", "model-a", "model-b", "model-c"]) {
    const directory = join(f.home, ".local/state/still/agents", id)
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, "state.json"), JSON.stringify({ ...f.worker, executionId: id, conversationId: id,
      parentConversationId: "parent", hasAcceptedPrompt: false, eventIndex: 2 }), { mode: 0o600 })
  }
  for (const id of ["human", "model-a", "model-b"]) reserveSharedChildSlot(f.home, id)
  assert.throws(() => reserveSharedChildSlot(f.home, "model-c"), /three active subagents/)
  const human = join(f.home, ".local/state/still/agents/human/state.json")
  await writeFile(human, JSON.stringify({ ...f.worker, executionId: "human", conversationId: "human", parentConversationId: "parent",
    hasAcceptedPrompt: true, busy: true, ended: true, eventIndex: 9 }), { mode: 0o600 })
  assert.throws(() => reserveSharedChildSlot(f.home, "model-c"), /three active subagents/, "provider loss is not proof an accepted turn finished")
  await writeFile(human, JSON.stringify({ ...f.worker, executionId: "human", conversationId: "human", parentConversationId: "parent",
    hasAcceptedPrompt: true, busy: false, eventIndex: 10 }), { mode: 0o600 })
  reserveSharedChildSlot(f.home, "model-c")
})

test("shared empty-project removal is a catalog tombstone, never a filesystem deletion or a deferred deletion of active work", async t => {
  const f = await fixture(t), project = registerSharedProject(f.home, "/srv/empty-folder")
  const page = sharedLibrary(f.home)
  const input = { kind: "project.delete", operationId: "remove-empty", serverAccountId: page.serverAccountId, expectedCatalogRevision: page.revision,
    projectId: project.id, cwd: project.cwd, expectedRevision: project.revision }
  assert.equal(mutateSharedLibrary(f.home, input).project.deleted, true)
  assert.equal(sharedLibrary(f.home).projects.find(item => item.id === project.id).deleted, true)
  const restored = registerSharedProject(f.home, "/srv/empty-folder")
  assert.equal(restored.deleted, false)
  const occupied = f.page.projects[0]
  const rejected = mutateSharedLibrary(f.home, { ...input, operationId: "do-not-remove-work", projectId: occupied.id, cwd: occupied.cwd, expectedRevision: occupied.revision })
  assert.equal(rejected.code, "projectNotEmpty")
  assert.equal(sharedLibrary(f.home).rows[0].conversationId, "conversation-a")
})
