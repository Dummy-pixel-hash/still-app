import { test, expect, type Page } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/__impeccable/**", route => route.abort())
  await page.route("**/live.js?*", route => route.abort())
  await page.emulateMedia({ reducedMotion: "reduce" })
})

async function openConversation(page: Page, scenario = "conversation") {
  await page.goto(`/tests-agents/fixture.html?demo&scenario=${scenario}`)
  await expect(page.locator(".agent-message-assistant").first()).toBeVisible()
}

async function expectDockWithinChat(page: Page) {
  await expect.poll(() => page.locator(".agent-composer-area").evaluate(element => {
    const dock = element.getBoundingClientRect(), chat = element.parentElement!.getBoundingClientRect()
    return dock.top >= chat.top && dock.bottom <= chat.bottom + 1 && chat.height - dock.height >= 40
  })).toBe(true)
  await expect.poll(() => page.locator(".agent-send").evaluate(element => {
    const rect = element.getBoundingClientRect()
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest(".agent-send") === element
  })).toBe(true)
}

test("Changes budgets both panes after navigation and follows the same layout for focus and scrims", async ({ page }) => {
  await openConversation(page)
  await page.getByRole("button", { name: "Review changes", exact: true }).click()
  const review = page.locator(".agent-review"), chat = page.locator(".agent-chat")
  for (const width of [1440, 1280, 1100, 1024, 1001, 1000, 801, 800, 620]) {
    await page.setViewportSize({ width, height: 800 })
    const overlay = width > 800 ? width - 288 < 960 : width < 960
    await expect(review).toHaveAttribute("role", overlay ? "dialog" : "complementary")
    await expect(page.locator(".agent-review-scrim")).toHaveCount(overlay ? 1 : 0)
    if (overlay) {
      await expect(review).toHaveAttribute("aria-modal", "true")
      await expect(chat).toHaveAttribute("inert", "")
      await review.getByRole("button", { name: "Close changes", exact: true }).focus()
      await page.keyboard.press("Shift+Tab")
      expect(await page.evaluate(() => !!document.activeElement?.closest(".agent-review"))).toBe(true)
    } else {
      await expect(chat).not.toHaveAttribute("inert")
      expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(460)
    }
  }
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Review changes", exact: true })).toBeFocused()
  await page.setViewportSize({ width: 1024, height: 800 })
  await page.getByRole("button", { name: "Collapse project sidebar", exact: true }).click()
  await page.getByRole("button", { name: "Review changes", exact: true }).click()
  await expect(review).toHaveAttribute("role", "complementary")
  expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(460)
  await page.setViewportSize({ width: 1023, height: 800 })
  await expect(review).toHaveAttribute("role", "dialog")
  await expect(chat).toHaveAttribute("inert", "")
})

test("a populated draft stays visible on blur, model selection, and conversation switches", async ({ page }) => {
  await openConversation(page)
  const input = page.getByLabel("Message agent", { exact: true }), composer = page.locator(".agent-composer")
  const draft = "Keep this unsent draft visible.\nIt must not turn into an empty model pill."
  await input.fill(draft)
  await page.getByRole("button", { name: "Find a message", exact: true }).focus()
  await expect(composer).not.toHaveClass(/is-collapsed/)
  await expect(input).toHaveCSS("opacity", "1")
  await expect(input).toHaveValue(draft)
  await expect(page.locator(".agent-context-line")).toBeVisible()
  await page.getByRole("button", { name: "Model: Claude Sonnet 4", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(composer).not.toHaveClass(/is-collapsed/)
  await page.locator(".agent-thread-open").filter({ hasText: "Fix reconnect on wake" }).click()
  await page.locator(".agent-thread-open").filter({ hasText: "Refine project navigation" }).click()
  await expect(input).toHaveValue(draft)
  await expect(composer).not.toHaveClass(/is-collapsed/)
  await input.fill("")
  await page.getByRole("button", { name: "Find a message", exact: true }).focus()
  await expect(composer).toHaveClass(/is-collapsed/)
})

test("long model and mode names cannot overlap the writing actions in narrow panes", async ({ page }) => {
  await openConversation(page)
  await page.getByLabel("Message agent", { exact: true }).fill("Keep the actions reachable")
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    const fields = h.configOptions()
    for (const field of fields) {
      if (field.category === "model") {
        field.options = [{ value: "long-model", name: "A custom enterprise model with a long display name" }]
        field.currentValue = "long-model"
      }
      if (field.category === "mode") {
        field.options = [{ value: "long-mode", name: "Read-only workspace mode" }]
        field.currentValue = "long-mode"
      }
    }
    h.emit(h.current, { type: "configOptions", configOptions: fields })
  })
  const mode = page.getByRole("button", { name: "Agent: Read-only workspace mode", exact: true })
  for (const width of [488, 390, 320]) {
    await page.setViewportSize({ width, height: 600 })
    await expect.poll(() => page.locator(".agent-composer-controls").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    const actions = (await page.locator(".agent-composer-actions").boundingBox())!, modeBounds = (await mode.boundingBox())!
    expect(modeBounds.x + modeBounds.width).toBeLessThanOrEqual(actions.x)
    await expect(mode).toHaveAttribute("title", "Agent: Read-only workspace mode")
    await mode.click()
    await expect(page.getByRole("option", { name: /^Read-only workspace mode/ })).toBeVisible()
    await page.keyboard.press("Escape")
    await expectDockWithinChat(page)
  }
})

test("Changes counts belong to their source instead of the generic header action", async ({ page }) => {
  await openConversation(page)
  await page.evaluate(() => { const h = (window as any).agentFixture; h.gitEntries = h.gitEntries.slice(0, 1) })
  const trigger = page.getByRole("button", { name: "Review changes", exact: true })
  await expect(trigger).toHaveText("Changes")
  await trigger.click()
  const repository = page.getByRole("tab", { name: "Repository", exact: true })
  const conversation = page.getByRole("tab", { name: "Conversation", exact: true })
  await expect(repository.locator("span")).toHaveText("1")
  await expect(conversation.locator("span")).toHaveText("2")
  await expect(repository).toHaveAccessibleDescription("1 repository file")
  await expect(page.locator(".agent-review-header")).toContainText("1 file")
  await conversation.click()
  await expect(page.locator(".agent-review-header")).toContainText("2 files")
  expect(await page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(1)
})

for (const [width, height] of [[1024, 600], [640, 480], [390, 400], [320, 360]]) {
  test(`Todos use an accessible separate view beside a multiline draft at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await openConversation(page, "todos")
    const input = page.getByLabel("Message agent", { exact: true }), draft = "Preserve this long draft.\n".repeat(12)
    await input.fill(draft)
    await expectDockWithinChat(page)
    const expand = page.getByRole("button", { name: "2 of 4 Todos done. Expand list", exact: true })
    await expand.click()
    const dialog = page.getByRole("dialog", { name: "Conversation Todos", exact: true })
    const collapse = dialog.getByRole("button", { name: "Collapse Todos", exact: true })
    await expect(collapse).toBeFocused()
    await expect(page.locator(".agent-main")).toHaveAttribute("inert", "")
    const bounds = (await dialog.boundingBox())!
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height)
    expect((await dialog.getByRole("list", { name: "Agent tasks" }).boundingBox())!.height).toBeGreaterThan(100)
    await collapse.press("Shift+Tab")
    await expect(dialog.getByRole("list", { name: "Agent tasks" })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(collapse).toBeFocused()
    await dialog.getByRole("listitem").last().scrollIntoViewIfNeeded()
    await expect(dialog.getByRole("listitem").last()).toBeInViewport()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(expand).toBeFocused()
    await expect(input).toHaveValue(draft)
    await expectDockWithinChat(page)
    await expect(page.locator(".agent-main")).not.toHaveAttribute("inert")
  })
}

test("stacked attention and Todos scroll without covering the header or composer actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 400 })
  await openConversation(page, "todos")
  await page.getByLabel("Message agent", { exact: true }).fill("Keep this draft\n".repeat(12))
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.emit(h.current, { type: "input", input: { requestId: "compact-question", title: "Choose a strategy", schema: { properties: { strategy: { type: "string", title: "Strategy" } } } } })
  })
  await expectDockWithinChat(page)
  const expand = page.getByRole("button", { name: "2 of 4 Todos done. Expand list", exact: true })
  await expand.scrollIntoViewIfNeeded()
  await expect(expand).toBeInViewport()
  await expand.click()
  await expect(page.getByRole("dialog", { name: "Conversation Todos", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  const request = page.getByRole("button", { name: /Your answer is needed/ })
  await request.scrollIntoViewIfNeeded()
  await request.click()
  await expect(page.getByRole("dialog", { name: "Choose a strategy", exact: true })).toBeVisible()
})

test("resizing an open Todo list between the dock and compact view keeps it reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openConversation(page, "todos")
  await page.getByLabel("Message agent", { exact: true }).fill("Keep this follow-up")
  await page.getByRole("button", { name: "2 of 4 Todos done. Expand list", exact: true }).click()
  await expect(page.locator(".agent-todos-dock .agent-todos")).toHaveClass(/is-expanded/)
  await page.setViewportSize({ width: 1024, height: 600 })
  const dialog = page.getByRole("dialog", { name: "Conversation Todos", exact: true })
  await expect(dialog.getByRole("button", { name: "Collapse Todos", exact: true })).toBeFocused()
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(".agent-main")).not.toHaveAttribute("inert")
  await expect(page.locator(".agent-todos-dock .agent-todos")).toHaveClass(/is-expanded/)
  await page.getByRole("button", { name: "Collapse Todos", exact: true }).click()
  await expect(page.getByRole("button", { name: "2 of 4 Todos done. Expand list", exact: true })).toBeFocused()
  await expect(page.getByLabel("Message agent", { exact: true })).toHaveValue("Keep this follow-up")
})

test("empty archived groups and unmatched message searches explain what happened", async ({ page }) => {
  await openConversation(page)
  await page.getByRole("button", { name: "Find a message", exact: true }).click()
  const search = page.getByLabel("Search this conversation", { exact: true })
  await search.fill("missing-phrase-49382")
  await expect(page.getByRole("status").filter({ hasText: "No messages match" })).toHaveText("No messages match “missing-phrase-49382”.")
  await page.getByRole("button", { name: "Clear search", exact: true }).click()
  await expect(search).toHaveValue("")
  await expect(search).toBeFocused()
  await expect(page.locator(".agent-timeline-results > button")).toHaveCount(2)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Archived", exact: true }).click()
  await expect(page.locator(".agent-thread-list")).toHaveText("No archived conversations.")
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("missing")
  await expect(page.locator(".agent-thread-list")).toHaveText("No matching conversations.")
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).fill("")
  await page.getByRole("button", { name: "All conversations", exact: true }).click()
  await expect(page.locator(".agent-thread-open")).toHaveCount(8)
})

test("message links offer an explicit open action and recover from browser failures", async ({ page }) => {
  await openConversation(page)
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.emit(h.current, { type: "assistantChunk", text: "Read [the docs](https://example.com/docs) or [unsafe](javascript:alert(1))." })
  })
  const link = page.getByRole("link", { name: "the docs", exact: true })
  await link.click()
  await expect(page.getByRole("button", { name: "Open link", exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).agentFixture.external)).toEqual([])
  await page.evaluate(() => { (window as any).agentFixture.rejectExternal = true })
  await page.getByRole("button", { name: "Open link", exact: true }).click()
  await expect(page.locator(".agent-link-feedback")).toContainText("Could not open your browser.")
  await page.evaluate(() => { (window as any).agentFixture.rejectExternal = false })
  await page.getByRole("button", { name: "Retry opening link", exact: true }).click()
  await expect(page.locator(".agent-link-feedback")).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).agentFixture.external)).toEqual(["https://example.com/docs"])
  await page.getByRole("link", { name: "unsafe", exact: true }).click({ modifiers: ["Control"] })
  await expect(page.locator(".agent-link-feedback")).toHaveText("Only HTTP and HTTPS links can be opened.")
  expect(await page.evaluate(() => (window as any).agentFixture.external)).toEqual(["https://example.com/docs"])
  expect(page.url()).toContain("/tests-agents/fixture.html")
})
