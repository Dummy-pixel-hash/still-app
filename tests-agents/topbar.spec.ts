import { test, expect } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/live.js?*", route => route.abort())
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo&layout=split")
  await page.locator(".agent-recent").first().click()
  await expect(page.locator(".agent-topbar--compact")).toBeVisible()
})

test("the accepted compact header has 32px icon actions and 12px corners", async ({ page }) => {
  const header = page.locator(".agent-main > .agent-topbar")
  await expect(header).toHaveCount(1)
  await expect(header).toHaveCSS("border-radius", "12px")
  for (const label of ["Find a message", "Review changes", "Close agent workspace"]) {
    const button = header.getByRole("button", { name: label, exact: true })
    await expect(button).toHaveAttribute("title", label)
    await expect(button).toHaveText("")
    await expect(button).toHaveCSS("width", "32px")
    await expect(button).toHaveCSS("height", "32px")
    await expect(button).toHaveCSS("border-radius", "6px")
  }
  const status = header.locator(".agent-status")
  await expect(status).toHaveText(/^(Saved|Ready)$/)
  const idleLabel = (await status.textContent())!
  await expect(status).toHaveAttribute("title", idleLabel)
  await expect(status.locator(".agent-sr-only")).toHaveText(idleLabel)
  expect((await status.boundingBox())!.width).toBeLessThanOrEqual(8)
  await expect(page.locator("[data-impeccable-variant], [data-impeccable-carbonize], style[data-impeccable-css]")).toHaveCount(0)
})

test("search and review actions work with keyboard focus returning to their icon", async ({ page }) => {
  const header = page.locator(".agent-topbar")
  const search = header.getByRole("button", { name: "Find a message", exact: true })
  await search.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByLabel("Search this conversation", { exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(search).toBeFocused()

  await header.getByRole("button", { name: "Review changes", exact: true }).click()
  await expect(page.locator(".agent-review")).toBeVisible()
  await header.getByRole("button", { name: "Back to chat", exact: true }).click()
  await expect(page.locator(".agent-review")).toHaveCount(0)
  await expect(header.getByRole("button", { name: "Review changes", exact: true })).toBeFocused()
})

test("working, attention and failure states retain visible text while idle uses just the dot", async ({ page }) => {
  const status = page.locator(".agent-topbar .agent-status")
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.emit(h.current, { type: "userMessage", text: "Check the header state" })
  })
  await expect(status.locator(".agent-topbar-status-label")).toHaveText("Working")
  await expect(status.locator(".agent-topbar-status-label")).toBeVisible()
  await page.evaluate(() => (window as any).agentFixture.approval())
  await expect(status.locator(".agent-topbar-status-label")).toHaveText("Needs you")
  await page.evaluate(() => (window as any).agentFixture.finish())
  await expect(status.locator(".agent-sr-only")).toHaveText("Ready")
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.emit(h.current, { type: "threadError", state: "error", text: "The agent disconnected." })
  })
  await expect(status.locator(".agent-topbar-status-label")).toHaveText("Turn failed")
  await expect(status).toHaveClass(/is-error/)
})

test("long titles and urgent status text stay inside the header at compact widths", async ({ page }) => {
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.emit(h.current, { type: "chatTitle", title: "Inspect the cross-platform reconnect implementation and verify that background conversations survive a network interruption" })
    h.emit(h.current, { type: "threadError", state: "error", turnActive: true, text: "The connection is recovering while the agent continues." })
  })
  const header = page.locator(".agent-topbar")
  await expect(header.locator(".agent-topbar-status-label")).toHaveText("Connection issue · still running")
  for (const [width, height] of [[1440, 900], [960, 768], [768, 900], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height })
    const rects = await header.evaluate(el => {
      const box = el.getBoundingClientRect()
      const children = [...el.children].map(child => child.getBoundingClientRect())
      return { left: box.left, right: box.right, leadingRight: children[0].right, actionsLeft: children[1].left,
        buttons: [...el.querySelectorAll("button")].map(button => { const r = button.getBoundingClientRect(); return { left: r.left, right: r.right } }) }
    })
    expect(rects.leadingRight).toBeLessThanOrEqual(rects.actionsLeft)
    for (const button of rects.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(rects.left)
      expect(button.right).toBeLessThanOrEqual(rects.right)
    }
    expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await expect(header.getByRole("button", { name: "Close agent workspace", exact: true })).toBeInViewport()
  }
})

test("close remains an explicit usable action", async ({ page }) => {
  await page.locator(".agent-topbar").getByRole("button", { name: "Close agent workspace", exact: true }).click()
  expect(await page.evaluate(() => (window as any).agentFixture.closed)).toBe(true)
})
