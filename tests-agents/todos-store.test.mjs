import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createTodoStore, readTodoSeed } from "../src-tauri/agent-host/todos.mjs"

const fixture = async () => {
  const root = await mkdtemp("/tmp/opencode/still-todos-store-")
  const directory = join(root, "store")
  await mkdir(directory)
  return { root, directory, file: join(directory, "todos.json") }
}

test("a failed write leaves the committed list, focus, and receipts unchanged", async () => {
  const { root, directory, file } = await fixture()
  const moved = `${directory}-moved`
  try {
    const store = createTodoStore(file)
    const first = store.apply({ action: "add", expectedRevision: 0, title: "Inspect the Todo store" }, "agent", "agent:1")
    const second = store.apply({ action: "add", expectedRevision: 1, title: "Run the focused checks" }, "agent", "agent:2")
    assert.equal(second.activeId, first.items[0].id)
    const before = store.snapshot()

    // Replace the store directory with a regular file so the next temp-file create
    // fails before rename. The committed file is preserved at the moved path.
    await rename(directory, moved)
    await writeFile(directory, "blocked")
    assert.throws(
      () => store.apply({ action: "focus", expectedRevision: 2, id: second.items[1].id, detail: "Running checks" }, "agent", "agent:3"),
      /ENOTDIR|not a directory|EACCES/i,
    )
    assert.deepEqual(store.snapshot(), before, "a failed write must not move the focused task or bump the revision")

    await unlink(directory)
    await rename(moved, directory)
    const retried = store.apply({ action: "focus", expectedRevision: 2, id: second.items[1].id, detail: "Running checks" }, "agent", "agent:3")
    assert.equal(retried.revision, 3)
    assert.equal(retried.activeId, second.items[1].id)
    assert.equal(retried.items[1].detail, "Running checks")
    assert.deepEqual(createTodoStore(file).snapshot(), retried, "the retry is durable and restart-safe")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a replayed request ID returns the committed list without a second mutation", async () => {
  const { root, file } = await fixture()
  try {
    const store = createTodoStore(file)
    const added = store.apply({ action: "add", expectedRevision: 0, title: "Inspect the Todo store" }, "agent", "agent:1")
    const item = added.items[0]

    // The reply may be lost after the rename committed; a retry must report that state.
    assert.deepEqual(store.apply({ action: "add", expectedRevision: 0, title: "Inspect the Todo store" }, "agent", "agent:1"), added)
    assert.equal(store.snapshot().revision, 1)
    assert.throws(
      () => store.apply({ action: "add", expectedRevision: 0, title: "A different task" }, "agent", "agent:1"),
      /already used/,
    )
    assert.throws(
      () => store.apply({ action: "update", expectedRevision: 0, id: item.id, status: "completed" }, "agent", "agent:2"),
      /changed/,
      "a new request ID cannot prove the caller saw the current revision",
    )
    assert.deepEqual(store.snapshot(), added)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("rejected mutations never change the committed revision or list", async () => {
  const { root, file } = await fixture()
  try {
    const store = createTodoStore(file)
    const added = store.apply({ action: "add", expectedRevision: 0, title: "Inspect the Todo store" }, "agent", "agent:1")
    const item = added.items[0]
    const attempts = [
      [{ action: "add", expectedRevision: 1, title: "   " }, "empty title"],
      [{ action: "add", expectedRevision: 1, title: "Task", status: "in_progress" }, "unsupported status"],
      [{ action: "update", expectedRevision: 1, id: "missing", status: "completed" }, "unknown item"],
      [{ action: "update", expectedRevision: 1, id: item.id, status: "completed", priority: "high" }, "unexpected field"],
      [{ action: "move", expectedRevision: 1, id: item.id, beforeId: item.id }, "self move"],
      [{ action: "focus", expectedRevision: 1, id: item.id, detail: "line\nbreak" }, "multi-line detail"],
    ]
    for (const [input, label] of attempts) {
      assert.throws(() => store.apply(input, "agent", `agent:${label}`), undefined, label)
      assert.deepEqual(store.snapshot(), added, label)
    }
    assert.throws(() => store.apply({ action: "add", expectedRevision: 1, title: "User edit" }, "user", "user:1"), /Only the agent tool/)
    assert.deepEqual(store.snapshot(), added)
    assert.deepEqual(createTodoStore(file).snapshot(), added)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("reactivating a completed task clears completion facts and keeps one focused task", async () => {
  const { root, file } = await fixture()
  try {
    const store = createTodoStore(file)
    const added = store.apply({ action: "add", expectedRevision: 0, title: "Inspect the Todo store" }, "agent", "agent:1")
    const id = added.items[0].id
    const completed = store.apply({ action: "update", expectedRevision: 1, id, status: "completed" }, "agent", "agent:2")
    assert.equal(completed.items[0].status, "completed")
    assert.ok(completed.items[0].completedAt >= completed.items[0].startedAt)
    assert.equal(completed.activeId, undefined, "a finished list has no focused task")

    const reopened = store.apply({ action: "update", expectedRevision: 2, id, status: "pending" }, "agent", "agent:3")
    assert.equal(reopened.items[0].status, "pending")
    assert.equal(reopened.items[0].completedAt, undefined)
    assert.equal(reopened.items[0].durationMs, undefined)
    assert.equal(reopened.activeId, id)

    const second = store.apply({ action: "add", expectedRevision: 3, title: "Run the focused checks" }, "agent", "agent:4")
    assert.equal(second.activeId, id, "adding work does not steal focus")
    const focused = store.apply({ action: "focus", expectedRevision: 4, id: second.items[1].id }, "agent", "agent:5")
    assert.equal(focused.activeId, second.items[1].id)
    assert.deepEqual(focused.items.filter(item => item.id === focused.activeId).map(item => item.status), ["pending"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("private seed reads are bounded, reject unsafe originals, and accept the maximum Unicode task state", async () => {
  const { root, directory, file } = await fixture()
  const seedFile = join(directory, "todo-seed.json")
  const seed = { revision: 12, activeId: "task-0", items: Array.from({ length: 100 }, (_, index) => ({
    id: `task-${index}`, title: "😀".repeat(500), detail: "🧭".repeat(500), status: "pending", createdBy: "agent", updatedBy: "agent",
  })) }
  try {
    assert.throws(() => readTodoSeed(directory), /declared Todo seed file is missing/)
    await writeFile(seedFile, JSON.stringify(seed), { mode: 0o600, flag: "wx" })
    assert.deepEqual(readTodoSeed(directory), seed)
    assert.deepEqual(createTodoStore(file, readTodoSeed(directory)).snapshot(), seed)
    const before = await readFile(file, "utf8")
    assert.ok(Buffer.byteLength(before) > 256 * 1024, "the maximal valid state exercises the former frame limit")
    assert.deepEqual(createTodoStore(file, seed).snapshot(), seed)
    assert.equal(await readFile(file, "utf8"), before, "opening a valid store must not rewrite evidence")

    await unlink(seedFile)
    await symlink(file, seedFile)
    assert.throws(() => readTodoSeed(directory), /ELOOP|symbolic link/i)
    assert.equal(await readFile(file, "utf8"), before)
    await unlink(seedFile)
    await mkdir(seedFile)
    assert.throws(() => readTodoSeed(directory), /Unsafe or oversized/)
    await rm(seedFile, { recursive: true })
    await writeFile(seedFile, "x".repeat(1024 * 1024 + 1), { mode: 0o600, flag: "wx" })
    assert.throws(() => readTodoSeed(directory), /Unsafe or oversized/)
    assert.equal((await readFile(seedFile)).length, 1024 * 1024 + 1, "failed reads preserve the seed for inspection")
  } finally { await rm(root, { recursive: true, force: true }) }
})
