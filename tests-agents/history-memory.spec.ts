import { expect, test } from "@playwright/test"

test("a 35-thread library lazily loads only the selected thread and keeps history windows bounded", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/__impeccable/**", route => route.abort())
  await page.route("**/live.js?*", route => route.abort())
  await page.addInitScript(() => {
    if (localStorage.getItem("still.test.memory-seeded")) return
    const host = JSON.stringify(["dev.example.test", 22, "dev"])
    const rows = Array.from({ length: 35 }, (_, index) => ({
      executionId: `memory-${index}`, conversationId: `memory-${index}`, localSessionId: "agent-fixture",
      agentId: "opencode", agentName: "OpenCode", cwd: "/srv/stress", state: "complete", lastSequence: 7323,
      transcript: [], historyLoaded: false, turnActive: false, configOptions: [], touchedAt: 1,
      meta: { id: `memory-${index}`, hostKey: host, folder: "/srv/stress", title: `Memory stress ${index}`, pinned: false, createdAt: 1, activityAt: 1, order: index, draft: "" },
    }))
    localStorage.setItem("still.test.agent-library", JSON.stringify({ rows, workspaces: {}, deleted: [] }))
    localStorage.setItem("still.test.agent-history:memory-0", JSON.stringify(Array.from({ length: 7323 }, (_, index) => ({
      type: index % 2 ? "assistantMessage" : "userMessage", attemptId: "memory-0", sequence: index + 1,
      text: `History message ${index + 1}: ` + "Project context. ".repeat(6),
    }))))
    localStorage.setItem("still.test.agent-changes:memory-0", JSON.stringify([{ id: "old-edit:src/old-file.ts", path: "src/old-file.ts", toolCallId: "old-edit", outcome: "completed" }]))
    localStorage.setItem("still.test.agent-change-details:memory-0:src/old-file.ts", JSON.stringify([
      { sequence: 7000, attemptId: "memory-0", type: "toolStart", toolCallId: "old-edit", title: "Edit file", toolKind: "edit", status: "completed", rawInput: { path: "src/old-file.ts" }, content: [{ type: "diff", path: "src/old-file.ts", oldText: "old historical content", newText: "new historical content" }] },
    ]))
    localStorage.setItem("still.test.memory-seeded", "yes")
  })
  await page.goto("/tests-agents/fixture.html")
  await expect(page.locator(".agent-thread-open")).toHaveCount(35)
  expect(await page.evaluate(() => (window as any).agentFixture.historyReads)).toEqual([])
  await page.locator(".agent-thread-open").filter({ hasText: /^Memory stress 0/ }).click()
  await expect(page.locator(".agent-message")).toHaveCount(200)
  await expect(page.locator(".agent-message").last()).toContainText("History message 7323:")
  await expect(page.locator(".agent-change-summary")).toContainText("1 changed file")
  await expect(page.locator(".agent-change-summary")).toHaveCSS("opacity", "0")
  await page.locator(".agent-chat").hover()
  await expect(page.locator(".agent-change-summary")).toHaveCSS("opacity", "1")
  await page.locator(".agent-change-summary").click()
  await expect(page.locator(".agent-review")).toContainText("src/old-file.ts")
  await expect(page.locator(".agent-review")).toContainText("new historical content")
  await page.getByRole("button", { name: "Back to chat" }).click()
  await page.locator(".agent-conversation").evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")) })
  await expect(page.locator(".agent-message")).toHaveCount(400)
  await expect(page.locator(".agent-message").first()).toContainText("History message 6924:")
  await expect(page.locator(".agent-message").last()).toContainText("History message 7323:")
  await expect(page.getByRole("button", { name: /Load earlier|Back to latest activity/ })).toHaveCount(0)
  await page.locator(".agent-conversation").evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")) })
  await page.locator(".agent-conversation").dispatchEvent("wheel", { deltaY: -120 })
  await expect(page.locator(".agent-message").first()).toContainText("History message 6724:")
  await expect(page.locator(".agent-message")).toHaveCount(400)
  await page.locator(".agent-conversation").evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")) })
  await expect(page.locator(".agent-message").last()).toContainText("History message 7323:")
  expect(await page.evaluate(() => (window as any).agentFixture.historyReads)).toEqual([{ id: "memory-0" }, { id: "memory-0", before: 7123 }, { id: "memory-0", before: 6923 }, { id: "memory-0", after: 7123 }])
  expect(await page.evaluate(() => (window as any).agentFixture.changeReads)).toEqual(["memory-0"])
  expect(errors).toEqual([])
})
