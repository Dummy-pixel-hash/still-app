import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { deliverSharedNotifications, mutateSharedLibrary, recordSharedWorker, sharedLibrary } from "../src-tauri/agent-host/shared-library.mjs"

async function fixture(t, enabled = true) {
  const home = await mkdtemp("/tmp/opencode/still-notification-outbox-")
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, ".local/state/still/agents/execution")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const worker = { version: 4, executionId: "execution", conversationId: "conversation", agentId: "opencode", cwd: "/srv/project", eventIndex: 10, busy: true, sessionResult: { sessionId: "provider" } }
  const save = async index => writeFile(join(directory, "state.json"), JSON.stringify({ ...worker, eventIndex: index }), { mode: 0o600 })
  await save(10)
  sharedLibrary(home)
  if (enabled) await writeFile(join(home, ".local/state/still/catalog-v1/notification-relay.json"), JSON.stringify({ enabled: true, url: "https://relay.example.invalid/v1/events", token: "fixture-only-secret-never-logged-or-forwarded" }), { mode: 0o600 })
  const file = join(home, ".local/state/still/catalog-v1/state.json")
  return { home, save, file, state: async () => JSON.parse(await readFile(file, "utf8")) }
}

test("notifications are opt-in and discovery/replay never manufacture fresh alerts", async t => {
  const f = await fixture(t, false)
  recordSharedWorker(f.home, "execution", { method: "session/request_permission", id: "request", _still: { index: 10 } })
  assert.equal(Object.keys((await f.state()).outbox || {}).length, 0)
  const result = await deliverSharedNotifications(f.home, async () => { throw new Error("Must not contact a relay") })
  assert.equal(result.configured, false)
})

test("durable alerts contain opaque routing only, deduplicate event IDs, and distinguish relay acceptance from phone delivery", async t => {
  const f = await fixture(t)
  const signal = { method: "session/request_permission", id: "approval", _still: { index: 10 }, params: { privateText: "PRIVATE_TRANSCRIPT", token: "PRIVATE_PROVIDER_TOKEN" } }
  const first = recordSharedWorker(f.home, "execution", signal)
  assert.equal(first.notificationQueued, true)
  recordSharedWorker(f.home, "execution", signal)
  sharedLibrary(f.home)
  const state = await f.state(), entries = Object.values(state.outbox)
  assert.equal(entries.length, 1)
  const encoded = JSON.stringify(state.outbox)
  for (const secret of ["PRIVATE_TRANSCRIPT", "PRIVATE_PROVIDER_TOKEN", "fixture-only-secret", "/srv/project"]) assert.equal(encoded.includes(secret), false)
  const delivered = await deliverSharedNotifications(f.home, async payload => {
    assert.equal(payload.eventId, entries[0].eventId)
    assert.equal(payload.kind, "needsInput")
    assert.equal(Object.hasOwn(payload, "token"), false)
    return true
  })
  assert.equal(delivered.accepted, 1)
  const accepted = Object.values((await f.state()).outbox)[0]
  assert.equal(typeof accepted.relayAcceptedAt, "number")
  assert.equal(Object.hasOwn(accepted, "phoneReceivedAt"), false)
  assert.equal((await deliverSharedNotifications(f.home, async () => { throw new Error("Already accepted") })).accepted, 0)
})

test("failed relay delivery retains bounded retry state and concurrent senders cannot claim the same live lease", async t => {
  const f = await fixture(t)
  recordSharedWorker(f.home, "execution", { method: "_still/turn_finished", params: { stopReason: "end_turn" }, _still: { index: 10 } })
  let sends = 0
  const results = await Promise.all([
    deliverSharedNotifications(f.home, async () => { sends++; await new Promise(resolve => setTimeout(resolve, 30)); return false }),
    deliverSharedNotifications(f.home, async () => { sends++; return true }),
  ])
  assert.equal(sends, 1)
  assert.ok(results.every(result => result.accepted === 0))
  const state = await f.state(), entry = Object.values(state.outbox)[0]
  assert.equal(entry.attempts, 1)
  assert.ok(entry.nextAttemptAt > Date.now())
  entry.nextAttemptAt = 0
  await writeFile(f.file, JSON.stringify(state), { mode: 0o600 })
  assert.equal((await deliverSharedNotifications(f.home, async () => true)).accepted, 1)
})

test("answering elsewhere or reading an outcome suppresses its unsent alert without transmitting private answer values", async t => {
  const f = await fixture(t)
  recordSharedWorker(f.home, "execution", { method: "elicitation/create", id: "question", _still: { index: 10 } })
  await f.save(11)
  recordSharedWorker(f.home, "execution", { method: "_still/request_outcome", params: { requestId: "question", outcome: "answered" }, _still: { index: 11 } })
  let called = false
  await deliverSharedNotifications(f.home, async () => { called = true; return true })
  assert.equal(called, false)
  await f.save(12)
  const current = recordSharedWorker(f.home, "execution", { method: "_still/turn_finished", params: { stopReason: "end_turn" }, _still: { index: 12 } })
  mutateSharedLibrary(f.home, { kind: "read.advance", operationId: "read-result", serverAccountId: current.serverAccountId,
    expectedCatalogRevision: current.catalogRevision, conversationId: current.conversationId, executionId: current.executionId,
    expectedGeneration: current.generation, cwd: "/srv/project", readThroughSeq: 12 })
  await deliverSharedNotifications(f.home, async () => { called = true; return true })
  assert.equal(called, false)
})
