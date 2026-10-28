import { test, expect, type Page } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/__impeccable/**", route => route.abort())
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html")
})

async function connect(page: Page) {
  if (!await page.getByRole("button", { name: "Add project folder", exact: true }).isVisible()) await page.getByRole("button", { name: "Toggle projects" }).click()
  await page.getByRole("button", { name: "Add project folder", exact: true }).click()
  await page.getByLabel("Remote project folder").fill("/srv/still")
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model: Model A", exact: true })).toBeEnabled()
  await page.getByLabel("Message agent").fill("Accessibility regression")
  await page.getByLabel("Message agent").press("Enter")
  await expect(page.locator(".agent-message-assistant")).toBeVisible()
  await page.evaluate(() => (window as any).agentFixture.finish())
}

test("provider and model pickers activate the focused option", async ({ page }) => {
  await page.getByRole("button", { name: "Coding agent: OpenCode", exact: true }).click()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("option", { name: /^Pi\b/ })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Coding agent: Pi", exact: true })).toBeFocused()
  await connect(page)
  await page.getByRole("button", { name: "Model: Model A", exact: true }).click()
  await page.getByRole("option", { name: "Model B" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("option", { name: "Model B" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await expect(page.getByRole("button", { name: "Model: Model B", exact: true })).toBeFocused()
})

test("command close and refresh buttons are not intercepted by Enter", async ({ page }) => {
  await connect(page)
  await page.getByRole("button", { name: "Commands and skills", exact: true }).click()
  await page.getByLabel("Search commands").fill("timeline")
  await page.getByRole("button", { name: "Close commands", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".agent-command-menu")).toHaveCount(0)
  await expect(page.getByRole("dialog", { name: "Find a message", exact: true })).toHaveCount(0)
  await expect(page.getByLabel("Message agent")).toBeFocused()
  await page.getByRole("button", { name: "Commands and skills", exact: true }).click()
  await page.getByLabel("Search commands").fill("timeline")
  await page.getByRole("button", { name: "Refresh commands", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".agent-command-menu")).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Find a message", exact: true })).toHaveCount(0)
})

test("model menu owns focus and restores it for mouse and command entry", async ({ page }) => {
  await connect(page)
  const trigger = page.getByRole("button", { name: "Model: Model A", exact: true })
  await trigger.click()
  await expect(page.getByRole("dialog", { name: "Model and reasoning", exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Search models", exact: true })).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  expect(await page.evaluate(() => !!document.activeElement?.closest(".agent-model-menu"))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
  await page.getByLabel("Message agent").press("ControlOrMeta+p")
  await page.getByLabel("Search commands").fill("models")
  await page.getByLabel("Search commands").press("Enter")
  await expect(page.getByRole("combobox", { name: "Search models", exact: true })).toBeFocused()
  await page.getByRole("button", { name: "Close model menu", exact: true }).click()
  await expect(trigger).toBeFocused()
})

test("project choices fit short windows and preserve focus", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  for (const [width, height] of [[640, 500], [550, 360], [320, 400]]) {
    await page.setViewportSize({ width, height })
    const trigger = page.getByRole("button", { name: "Choose project", exact: true })
    await trigger.click()
    const popup = page.locator(".agent-context-choices")
    await expect(page.getByRole("button", { name: "Close project choices", exact: true })).toBeFocused()
    await expect(page.getByRole("button", { name: "Close project choices", exact: true })).toBeInViewport()
    expect(await popup.evaluate(el => {
      const box = el.getBoundingClientRect(), chat = el.closest(".agent-chat")!.getBoundingClientRect()
      return box.top >= chat.top && box.bottom <= chat.bottom && box.left >= chat.left && box.right <= chat.right
    })).toBe(true)
    await page.getByRole("button", { name: "Close project choices", exact: true }).click()
    await expect(trigger).toBeFocused()
  }
})

test("form dialogs isolate the background and focus their fields", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Add project folder", exact: true })
  await trigger.click()
  await expect(page.getByLabel("Project server")).toBeFocused()
  await expect(page.locator(".agent-main")).toHaveAttribute("inert", "")
  await expect(page.locator(".agent-sidebar")).toHaveAttribute("inert", "")
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
  await expect(page.locator(".agent-main")).not.toHaveAttribute("inert")
  await connect(page)
  const find = page.getByRole("button", { name: "Find a message", exact: true })
  await find.click()
  await expect(page.getByLabel("Search this conversation")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(find).toBeFocused()
})

test("approvals keep actions visible and announce attention without stealing focus", async ({ page }) => {
  await page.setViewportSize({ width: 550, height: 360 })
  await connect(page)
  await page.getByLabel("Message agent").focus()
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.emit(h.current, { type: "permission", permission: { requestId: "a11y-approval", title: "Run project checks", description: "Review the requested commands.", command: "npm run build\nnpm run lint\nnpm test", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } })
  })
  await expect(page.locator(".agent-sr-only[role=status]")).toHaveText("Approval needed: Run project checks")
  await expect(page.locator(".agent-status")).toHaveText("Needs you")
  await expect(page.getByLabel("Message agent")).toBeFocused()
  await page.getByRole("button", { name: /Approval needed.*Review request/ }).click()
  for (const name of ["Allow once", "Deny"]) {
    const button = page.getByRole("button", { name, exact: true })
    await expect(button).toBeInViewport()
    expect(await button.evaluate(el => el.getBoundingClientRect().bottom <= el.closest(".agent-request-card")!.getBoundingClientRect().bottom)).toBe(true)
  }
  await page.getByRole("button", { name: "Close expanded request" }).click()
  await expect(page.locator(".agent-context-line small")).toBeVisible()
  await expect(page.locator(".agent-context-line small")).toBeInViewport()
  await expect(page.getByLabel("Message agent")).toBeInViewport()
})

test("questions link descriptions and preserve zero numeric answers", async ({ page }) => {
  await connect(page)
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.emit(h.current, { type: "input", input: { requestId: "a11y-question", title: "How many retries?", schema: { properties: { retries: { type: "integer", title: "Retries", description: "Use zero to disable retries." } }, required: ["retries"] } } })
  })
  const field = page.getByLabel("Retries", { exact: true })
  await expect(field).toHaveAccessibleDescription("Use zero to disable retries.")
  await field.fill("0")
  await page.getByRole("button", { name: "Submit answer", exact: true }).click()
  expect(await page.evaluate(() => (window as any).agentFixture.inputs.at(-1))).toMatchObject({ answers: { retries: 0 } })
})

test("default desktop window keeps review beside an editable conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 })
  await connect(page)
  await page.evaluate(() => (window as any).agentFixture.populate())
  await page.getByRole("button", { name: "Review changes", exact: true }).click()
  const review = page.getByRole("complementary", { name: "Conversation changes", exact: true })
  await expect(review).toBeVisible()
  await expect(page.locator(".agent-chat")).not.toHaveAttribute("inert")
  await page.getByLabel("Message agent").fill("Follow-up while reviewing")
  expect(await review.locator(".agent-patch").evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13)
})

test("failed conversations retain an explicit sidebar state on compact screens", async ({ page }) => {
  await connect(page)
  await page.evaluate(() => { const h = (window as any).agentFixture; h.emit(h.current, { type: "threadError", state: "error", text: "Agent disconnected." }) })
  await page.setViewportSize({ width: 620, height: 700 })
  await page.getByRole("button", { name: "Toggle projects", exact: true }).click()
  await expect(page.locator(".agent-thread-indicator.error")).toBeVisible()
  await expect(page.locator(".agent-attention-label.is-error")).toHaveText("Failed")
  await expect(page.locator(".agent-thread-open")).toHaveAccessibleName(/Failed/)
})

test("returning users see all featured recents and a route to the full library", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  await expect(page.locator(".agent-recent")).toHaveCount(3)
  for (const row of await page.locator(".agent-recent").all()) await expect(row).toBeInViewport()
  await page.getByRole("button", { name: "View all 8 conversations", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Search conversations", exact: true })).toBeFocused()
})

test("reasoning changes within the model menu using the keyboard", async ({ page }) => {
  await connect(page)
  await page.getByRole("button", { name: "Model: Model A", exact: true }).click()
  await page.getByRole("radio", { name: "High", exact: true }).focus()
  await page.keyboard.press("Space")
  await expect(page.getByRole("radio", { name: "High", exact: true })).toBeChecked()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Model: Model A", exact: true })).toBeFocused()
})
