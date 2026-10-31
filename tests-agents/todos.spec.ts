import { test, expect, type Page } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/__impeccable/**", route => route.abort())
  await page.route("**/live.js?*", route => route.abort())
  await page.goto("/tests-agents/fixture.html")
})

async function startConversation(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(1)
  await page.getByRole("button", { name: "Add project folder", exact: true }).click()
  await page.getByLabel("Remote project folder").fill("/srv/still")
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
  await page.getByLabel("Message agent").fill("Preserve the conversation Todo list")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.locator(".agent-message-assistant").last()).toContainText("First second third.")
  await page.evaluate(() => (window as any).agentFixture.finish())
  await page.getByLabel("Message agent").focus()
  await expect(page.getByRole("button", { name: "Model: Model A" })).toBeEnabled()
  return page.evaluate(() => (window as any).agentFixture.current as string)
}

function todos(revision = 7) {
  return { protocolVersion: 3, revision, available: true, toolAvailable: true, activeId: "pending-task", items: [
    { id: "done-task", title: "Verify durable task storage", status: "completed", createdBy: "agent", updatedBy: "agent", startedAt: 10, completedAt: 28010, durationMs: 28000 },
    { id: "pending-task", title: "Keep current Todos across history changes", status: "pending", createdBy: "agent", updatedBy: "agent", startedAt: Date.now(), detail: "Checking revisions and recovery." },
  ] }
}

test("Todo reconciliation ignores old revisions/attempts and refreshes an equal-revision conflict only once", async ({ page }) => {
  const id = await startConversation(page)
  const original = todos()
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos }), { id, todos: original })
  const pill = page.getByRole("button", { name: "1 of 2 Todos done. Expand list" })
  await expect(pill).toBeVisible()
  const before = await page.evaluate(id => {
    const row = (window as any).agentThreadRows.find((row: any) => row.executionId === id)
    return { activity: row.meta.activityAt, turn: row.turnActive, state: row.state, snapshots: (window as any).agentFixture.snapshotReads.length }
  }, id)
  await page.evaluate(({ id, todos }) => {
    const fixture = (window as any).agentFixture
    fixture.rawTodoEvent(id, { type: "todos", todos: { ...todos, revision: 1 } })
    fixture.rawTodoEvent(id, { type: "todos", attemptId: "previous-execution", todos: { ...todos, revision: 99 } })
  }, { id, todos: original })
  expect(await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id).todos.revision, id)).toBe(7)

  const divergent = { ...original, items: original.items.map(item => ({ ...item, title: "Divergent task content" })) }
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.rawTodoEvent(id, { type: "todos", todos }), { id, todos: divergent })
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.snapshotReads.length)).toBe(before.snapshots + 1)
  await page.evaluate(({ id, todos }) => {
    const fixture = (window as any).agentFixture
    fixture.rawTodoEvent(id, { type: "todos", todos })
    fixture.rawTodoEvent(id, { type: "todos", todos })
  }, { id, todos: divergent })
  expect(await page.evaluate(() => (window as any).agentFixture.snapshotReads.length)).toBe(before.snapshots + 1)
  await pill.click()
  await expect(page.locator(".agent-todos-offline")).toHaveText("Showing saved Todos; the remote list does not match.")
  await expect(page.locator(".agent-todo-readonly-title").nth(1)).toHaveText("Keep current Todos across history changes")
  const row = await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id), id)
  expect(row.turnActive).toBe(before.turn)
  expect(row.state).toBe(before.state)
  expect(row.meta.activityAt).toBe(before.activity)
  expect(row.transcript.some((event: any) => event.type === "todos")).toBe(false)
})

test("offline and unavailable Todo observations remain read-only without changing the composer pill", async ({ page }) => {
  const id = await startConversation(page)
  const original = todos()
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos }), { id, todos: original })
  await page.getByRole("button", { name: "Find a message" }).focus()
  const composer = page.locator(".agent-composer"), pill = page.getByRole("button", { name: "1 of 2 Todos done. Expand list" })
  await expect(composer).toHaveClass(/is-collapsed/)
  await expect.poll(async () => Math.round((await composer.boundingBox())!.width)).toBe(360)
  const width = (await composer.boundingBox())!.width
  await pill.click()
  await page.evaluate(id => (window as any).agentFixture.emit(id, { type: "threadState", state: "detached" }), id)
  await expect(page.locator(".agent-todos-offline")).toContainText("Showing saved Todos")
  await expect(page.locator(".agent-todo-readonly-meta").first()).toContainText("28s")
  expect((await composer.boundingBox())!.width).toBe(width)
  await expect(page.locator(".agent-todos-dock input,.agent-todos-dock select,.agent-todos-dock textarea")).toHaveCount(0)
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos: { ...todos, available: false, toolAvailable: false } }), { id, todos: original })
  await expect(page.locator(".agent-todos-offline")).toContainText("This execution cannot provide Todo updates")
  await expect(page.locator(".agent-todos-offline")).not.toContainText("older agent")
})

test("Revert and offline reload preserve the latest shared task state", async ({ page }) => {
  const id = await startConversation(page), original = todos()
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos }), { id, todos: original })
  const messageId = await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id).transcript.find((event: any) => event.type === "userMessage").messageId, id)
  await page.getByLabel("Message agent").fill("An unrelated saved draft")
  await page.getByRole("button", { name: "Revert", exact: true }).first().click()
  await page.getByRole("dialog", { name: "Revert to this message?", exact: true }).getByRole("button", { name: "Revert conversation", exact: true }).click()
  await expect(page.locator(".agent-message-user")).toHaveCount(0)
  const after = await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id).todos, id)
  expect(after).toEqual(original)
  await expect(page.getByLabel("Message agent")).toHaveValue("An unrelated saved draft")
  await page.reload()
  await expect.poll(() => page.evaluate(id => (window as any).agentThreadRows?.find((row: any) => row.executionId === id)?.todos?.revision, id)).toBe(7)
  const restored = await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id), id)
  expect(restored.todos).toEqual(original)
  expect(restored.todoSync.state).toBe("stale")
  expect(restored.transcript.some((event: any) => event.type === "todos")).toBe(false)
  expect(messageId).toBeTruthy()
})

test("Retry and provider resume keep the same current tasks and fixed completed durations", async ({ page }) => {
  await page.evaluate(() => { (window as any).agentFixture.resumable = true })
  const id = await startConversation(page), original = todos()
  await page.getByLabel("Message agent").fill("A later prompt to retry")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await page.evaluate(() => (window as any).agentFixture.finish())
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos }), { id, todos: original })
  await page.getByLabel("Message agent").fill("An unrelated saved draft")
  const later = page.locator(".agent-message-user").filter({ hasText: "A later prompt to retry" })
  await later.getByRole("button", { name: "Retry", exact: true }).click()
  await page.getByRole("button", { name: "Retry message", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.sends.length)).toBe(3)
  expect(await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id).todos, id)).toEqual(original)
  await expect(page.getByLabel("Message agent")).toHaveValue("An unrelated saved draft")
  await page.evaluate(async () => { const fixture = (window as any).agentFixture; fixture.finish(); await fixture.flush() })
  await page.reload()
  await page.locator(".agent-thread-open").filter({ hasText: "Preserve the conversation Todo list" }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.starts.length)).toBe(1)
  await expect.poll(() => page.evaluate(() => {
    const fixture = (window as any).agentFixture
    return (window as any).agentThreadRows.find((row: any) => row.executionId === fixture.current)?.todos?.revision
  })).toBe(7)
  const resumed = await page.evaluate(() => (window as any).agentThreadRows.find((row: any) => row.executionId === (window as any).agentFixture.current))
  expect(resumed.executionId).not.toBe(id)
  expect(resumed.todos).toEqual(original)
  expect(resumed.todos.items[0].durationMs).toBe(28000)
  expect(await page.evaluate(() => (window as any).agentFixture.sends)).toEqual([])
})

test("an authoritative lower remote list and malformed updates cannot reset the saved tasks or permissions", async ({ page }) => {
  const id = await startConversation(page), original = todos()
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos }), { id, todos: original })
  await page.evaluate(() => (window as any).agentFixture.approval())
  const stateBefore = await page.evaluate(id => {
    const row = (window as any).agentThreadRows.find((row: any) => row.executionId === id)
    return { state: row.state, turnActive: row.turnActive, permission: row.pendingPermission.requestId }
  }, id)
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos: { ...todos, items: [{ ...todos.items[0], status: "in_progress" }] } }), { id, todos: original })
  const afterInvalid = await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id), id)
  expect(afterInvalid.todos).toEqual(original)
  expect(afterInvalid.todoSync.state).toBe("unavailable")

  await page.evaluate(async ({ id, todos }) => {
    const fixture = (window as any).agentFixture
    fixture.setSnapshotTodos(id, { ...todos, revision: 0, items: [], activeId: undefined })
    await fixture.refreshThread(id)
  }, { id, todos: original })
  const conflict = await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id), id)
  expect(conflict.todos).toEqual(original)
  expect(conflict.todoSync.state).toBe("conflict")
  expect(conflict.state).toBe(stateBefore.state)
  expect(conflict.turnActive).toBe(stateBefore.turnActive)
  expect(conflict.pendingPermission.requestId).toBe(stateBefore.permission)
})

test("completing every Todo does not complete the turn or approve an outstanding request", async ({ page }) => {
  const id = await startConversation(page), original = todos()
  await page.getByLabel("Message agent").fill("Work while waiting for approval")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await page.evaluate(() => (window as any).agentFixture.approval())
  const completed = { ...original, revision: 8, activeId: undefined, items: original.items.map(item => ({ ...item, status: "completed" })) }
  const before = await page.evaluate(id => {
    const row = (window as any).agentThreadRows.find((row: any) => row.executionId === id)
    return { state: row.state, active: row.turnActive, requestId: row.pendingPermission.requestId, approvals: (window as any).agentFixture.approvals.length }
  }, id)
  expect(before.state).toBe("inputRequired")
  expect(before.active).toBe(true)
  await page.evaluate(({ id, todos }) => (window as any).agentFixture.emit(id, { type: "todos", todos }), { id, todos: completed })
  await expect(page.getByRole("button", { name: "2 of 2 Todos done. Expand list" })).toBeVisible()
  const after = await page.evaluate(id => {
    const row = (window as any).agentThreadRows.find((row: any) => row.executionId === id)
    return { state: row.state, active: row.turnActive, requestId: row.pendingPermission.requestId, approvals: (window as any).agentFixture.approvals.length }
  }, id)
  expect(after).toEqual(before)
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible()
})

test("persistent reconnect accepts current worker Todos without duplicating a prompt", async ({ page }) => {
  await page.evaluate(() => { (window as any).agentFixture.persistent = true })
  const id = await startConversation(page), original = todos()
  await page.evaluate(async ({ id, todos }) => {
    const fixture = (window as any).agentFixture
    fixture.emit(id, { type: "todos", todos })
    await fixture.flush()
  }, { id, todos: original })
  await page.reload()
  await page.locator(".agent-thread-open").filter({ hasText: "Preserve the conversation Todo list" }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.attaches.length)).toBe(1)
  const restored = await page.evaluate(id => (window as any).agentThreadRows.find((row: any) => row.executionId === id), id)
  expect(restored.todos).toEqual(original)
  expect(restored.todoSync.state).toBe("current")
  expect(await page.evaluate(() => (window as any).agentFixture.starts)).toEqual([])
  expect(await page.evaluate(() => (window as any).agentFixture.sends)).toEqual([])
})
