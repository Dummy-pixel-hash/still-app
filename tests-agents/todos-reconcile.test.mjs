import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/agents/todos.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } })
const { normalizeTodos, reconcileTodos, restoreTodos, todoTaskState } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)
const list = revision => ({ protocolVersion: 3, revision, available: true, toolAvailable: true, activeId: "task", items: [
  { id: "task", title: "Keep the current shared list", status: "pending", createdBy: "agent", updatedBy: "agent", startedAt: 10, detail: "Checking restore." },
] })

test("equal Todo revision permits readiness changes but not task content changes", () => {
  const old = list(7), next = { ...list(7), toolAvailable: false }
  const accepted = reconcileTodos(old, { state: "current" }, next)
  assert.equal(accepted.todos.toolAvailable, false)
  assert.equal(todoTaskState(accepted.todos), todoTaskState(old))
  const divergent = list(7); divergent.items[0].title = "Do not overwrite at the same revision"
  const rejected = reconcileTodos(old, { state: "current" }, divergent)
  assert.deepEqual(rejected.todos, old)
  assert.equal(rejected.todoSync.state, "conflict")
  assert.equal(rejected.refresh, true)
  assert.equal(reconcileTodos(old, rejected.todoSync, divergent, { state: "conflict" }).refresh, false)
})

test("ordinary old replay is ignored while authoritative lower state is a readable conflict", () => {
  const old = list(7)
  assert.equal(reconcileTodos(old, { state: "current" }, list(0)).todoSync.state, "current")
  const conflict = reconcileTodos(old, { state: "current" }, list(0), undefined, { authoritative: true })
  assert.deepEqual(conflict.todos, old)
  assert.equal(conflict.todoSync.state, "conflict")
  assert.equal(conflict.refresh, false)
  assert.equal(reconcileTodos(old, conflict.todoSync, old, { state: "current" }, { authoritative: true }).todoSync.state, "current")
})

test("invalid Todo updates preserve the readable list and saved restore marks only observation stale", () => {
  const old = list(7), invalid = list(8); invalid.items[0].status = "in_progress"
  const result = reconcileTodos(old, { state: "current" }, invalid, { state: "current" })
  assert.deepEqual(result.todos, old)
  assert.equal(result.todoSync.state, "unavailable")
  const restored = restoreTodos(old, { state: "current" })
  assert.deepEqual(restored.todos, old)
  assert.equal(restored.todoSync.state, "stale")
  assert.equal(restored.todos.available, true)
  assert.equal(restored.todos.toolAvailable, true)
  assert.equal(restoreTodos(old, { state: "conflict" }).todoSync.state, "conflict")
  const invalidRestore = { todos: invalid, ...restoreTodos(invalid, { state: "current" }) }
  assert.equal(invalidRestore.todos, undefined, "invalid cached task state is explicitly cleared during row merges")
  assert.equal(invalidRestore.todoSync.state, "unavailable")
  assert.equal(normalizeTodos({ ...old, items: [{ ...old.items[0], title: "line\nbreak" }] }), undefined)
  assert.equal(normalizeTodos({ ...old, items: [old.items[0], old.items[0]] }), undefined)
})
