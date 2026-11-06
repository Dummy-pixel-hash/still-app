import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, unlink, symlink, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { recoverExecutionOwner, verifyExecutionRecovery, workerBootId } from "../src-tauri/agent-host/recovery.mjs"
import { createTodoStore } from "../src-tauri/agent-host/todos.mjs"

async function fixture(run) {
  const root = await mkdtemp("/tmp/opencode/still-recovery-")
  const directory = join(root, "new-execution"), previousDirectory = join(root, "old-execution"), todoDirectory = join(root, "todos")
  for (const path of [directory, previousDirectory, todoDirectory]) await mkdir(path, { mode: 0o700 })
  const config = { executionId: "new-execution", conversationId: "conversation", agentId: "pi", cwd: root, create: true, recoverFrom: { executionId: "old-execution", agentSessionId: "saved-session" } }
  const state = { executionId: "old-execution", conversationId: config.conversationId, cwd: root, agentId: "pi", pid: 2_000_000_000, childPid: 2_000_000_001, closed: false, ended: false, sessionResult: { sessionId: "saved-session" } }
  const statePath = join(previousDirectory, "state.json"), ownerPath = join(todoDirectory, "owner.lock")
  const saveState = () => writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
  const saveOwner = (owner = { executionId: "old-execution", pid: state.pid }) => writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 })
  await saveState(); await saveOwner()
  try { await run({ root, directory, previousDirectory, todoDirectory, config, state, statePath, ownerPath, saveState, saveOwner }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test("explicit recovery replaces only a verified dead execution owner and keeps its Todos and journal", () => fixture(async f => {
  const todoPath = join(f.todoDirectory, "todos.json"), journal = join(f.previousDirectory, "events.jsonl")
  const store = createTodoStore(todoPath)
  store.apply({ action: "add", expectedRevision: 0, title: "Keep the prior checklist" }, "agent", "recovery:seed")
  await writeFile(journal, "prior execution history\n", { mode: 0o600 })
  const before = await readFile(todoPath, "utf8"), beforeState = await readFile(f.statePath, "utf8")
  const owner = recoverExecutionOwner(f.directory, f.todoDirectory, f.config)
  try {
    assert.deepEqual(JSON.parse(await readFile(f.ownerPath, "utf8")), { executionId: "new-execution", pid: process.pid })
    assert.equal(await readFile(todoPath, "utf8"), before)
    assert.equal(await readFile(f.statePath, "utf8"), beforeState)
    assert.equal(await readFile(journal, "utf8"), "prior execution history\n")
    await assert.rejects(stat(join(f.todoDirectory, "recovery.lock")), { code: "ENOENT" })
  } finally { owner.release() }
}))

for (const live of ["worker", "provider"]) test(`recovery refuses a live ${live} even when its socket is missing`, () => fixture(async f => {
  if (live === "worker") f.state.pid = process.pid
  else f.state.childPid = process.pid
  await f.saveState(); await f.saveOwner()
  const before = await readFile(f.ownerPath, "utf8")
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config), /still running/)
  assert.equal(await readFile(f.ownerPath, "utf8"), before)
}))

test("a recorded previous boot permits recovery without confusing reused PIDs for old processes", { skip: !workerBootId() }, () => fixture(async f => {
  f.state.bootId = workerBootId() === "00000000-0000-0000-0000-000000000000" ? "11111111-1111-1111-1111-111111111111" : "00000000-0000-0000-0000-000000000000"
  f.state.pid = process.pid; f.state.childPid = process.pid
  await f.saveState(); await f.saveOwner()
  const owner = recoverExecutionOwner(f.directory, f.todoDirectory, f.config)
  owner.release()
}))

test("legacy worker records remain recoverable after both recorded processes have gone", () => fixture(async f => {
  delete f.state.conversationId; delete f.state.cwd; delete f.state.agentId
  await f.saveState()
  const owner = recoverExecutionOwner(f.directory, f.todoDirectory, f.config)
  owner.release()
}))

test("bootstrap preflight verifies recovery without changing either execution's ownership", () => fixture(async f => {
  const before = await readFile(f.ownerPath, "utf8")
  verifyExecutionRecovery(f.directory, f.config, f.todoDirectory)
  assert.equal(await readFile(f.ownerPath, "utf8"), before)
  await assert.rejects(stat(join(f.todoDirectory, "recovery.lock")), { code: "ENOENT" })
}))

test("an ended provider can be resumed while its retired supervisor remains alive", () => fixture(async f => {
  f.state.pid = process.pid; f.state.ended = true
  await f.saveState(); await unlink(f.ownerPath)
  const owner = recoverExecutionOwner(f.directory, f.todoDirectory, f.config)
  owner.release()
}))

for (const field of ["executionId", "conversationId", "cwd", "agentId"]) test(`recovery refuses a mismatched ${field}`, () => fixture(async f => {
  f.state[field] = "another-identity"; await f.saveState()
  const before = await readFile(f.ownerPath, "utf8")
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config), /does not match/)
  assert.equal(await readFile(f.ownerPath, "utf8"), before)
}))

test("recovery refuses another provider session and unrelated Todo ownership", () => fixture(async f => {
  f.config.recoverFrom.agentSessionId = "wrong-session"
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config), /does not match/)
  f.config.recoverFrom.agentSessionId = "saved-session"
  await f.saveOwner({ executionId: "other-execution", pid: f.state.pid })
  const before = await readFile(f.ownerPath, "utf8")
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config), /Another execution owns/)
  assert.equal(await readFile(f.ownerPath, "utf8"), before)
}))

test("a competing recovery cannot remove the replacement's owner", () => fixture(async f => {
  const owner = recoverExecutionOwner(f.directory, f.todoDirectory, f.config)
  try {
    const before = await readFile(f.ownerPath, "utf8")
    assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, { ...f.config, executionId: "third-execution" }), /Another execution owns/)
    assert.equal(await readFile(f.ownerPath, "utf8"), before)
  } finally { owner.release() }
}))

test("ambiguous recovery guards and symlinked ownership are never reaped", () => fixture(async f => {
  const guard = join(f.todoDirectory, "recovery.lock")
  await writeFile(guard, "interrupted recovery", { mode: 0o600 })
  assert.throws(() => verifyExecutionRecovery(f.directory, f.config, f.todoDirectory), /Another recovery owns/)
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config), /Another recovery owns/)
  assert.equal(await readFile(guard, "utf8"), "interrupted recovery")
  await unlink(guard)
  const target = join(f.root, "unrelated-owner.json")
  await writeFile(target, await readFile(f.ownerPath), { mode: 0o600 })
  await unlink(f.ownerPath); await symlink(target, f.ownerPath)
  const before = await readFile(target, "utf8")
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config))
  assert.equal(await readFile(target, "utf8"), before)
}))

test("unverifiable execution records and path traversal do not release ownership", () => fixture(async f => {
  const before = await readFile(f.ownerPath, "utf8")
  await unlink(f.statePath)
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config))
  f.config.recoverFrom.executionId = "../another-execution"
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config), /Invalid/)
  assert.equal(await readFile(f.ownerPath, "utf8"), before)
}))

for (const contents of ["null", "[]", "{invalid-json"]) test(`malformed recovery state (${contents}) keeps the original owner intact`, () => fixture(async f => {
  const before = await readFile(f.ownerPath, "utf8")
  await writeFile(f.statePath, contents)
  assert.throws(() => verifyExecutionRecovery(f.directory, f.config, f.todoDirectory), /Invalid recovery record/)
  assert.throws(() => recoverExecutionOwner(f.directory, f.todoDirectory, f.config), /Invalid recovery record/)
  assert.equal(await readFile(f.ownerPath, "utf8"), before)
}))
