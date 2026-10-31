import { test, expect, type Page } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/__impeccable/**", route => route.abort())
  await page.route("**/live.js?*", route => route.abort())
  await page.goto("/tests-agents/fixture.html")
})

async function addFolder(page: Page) {
  if (!await page.getByRole("button", { name: "Add project folder", exact: true }).isVisible()) await page.getByRole("button", { name: "Toggle projects" }).click()
  await page.getByRole("button", { name: "Add project folder", exact: true }).click()
  await page.getByLabel("Remote project folder").fill("/srv/still")
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
}

async function startFixtureThread(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(1)
  await addFolder(page)
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.starts.length)).toBe(1)
  const id = await page.evaluate(() => (window as any).agentFixture.current)
  await page.evaluate(id => {
    const fixture = (window as any).agentFixture
    fixture.emit(id, { type: "userMessage", text: "Record capability evidence" })
    fixture.finish()
  }, id)
  await expect.poll(() => page.evaluate(id => (window as any).agentThreadRows?.find((row: any) => row.executionId === id)?.transcript.some((event: any) => event.type === "userMessage"), id)).toBe(true)
  return id as string
}

function report(scope: { executionId: string; agentSessionId: string; cwd: string }, configGeneration: number) {
  return {
    schemaVersion: 1,
    executionId: scope.executionId,
    agentSessionId: scope.agentSessionId,
    cwd: scope.cwd,
    configGeneration,
    observedAt: Date.now(),
    providerRuntime: { transport: "http-v2+sse", executable: "/home/dev/.local/bin/opencode", version: "2.fixture", versionSource: "runtime", versionObservedAt: Date.now() },
    features: {
      sharedTodos: { status: "supported", evidence: "observed", reason: "An authenticated tool request was accepted." },
      providerPlans: { status: "unsupported", evidence: "adapter", reason: "This integration does not consume structured plans." },
      providerTaskProjection: { status: "unsupported", evidence: "adapter", reason: "Native tasks are not synchronized." },
      clientTodoWrite: { status: "unsupported", evidence: "adapter", reason: "The agent owns Todo changes." },
    },
    freshness: "current",
  }
}

test("capability updates stay metadata, reject old scopes/generations, and restore stale", async ({ page }) => {
  const id = await startFixtureThread(page)
  const scope = await page.evaluate(id => {
    const row = (window as any).agentThreadRows.find((item: any) => item.executionId === id)
    return { executionId: row.executionId, agentSessionId: row.agentSessionId, cwd: row.cwd, activityAt: row.meta.activityAt }
  }, id)
  const current = report(scope, 2)
  const trigger = page.getByRole("button", { name: "Agent details: Supported by this agent" })
  const dialog = page.getByRole("dialog", { name: "Supported by this agent" })

  await trigger.focus()
  await page.keyboard.press("Enter")
  await expect(dialog.getByText("Version not reported", { exact: true })).toBeVisible()
  await expect(dialog.getByText("This execution does not report capability details.")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await page.keyboard.press("Space")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)

  const advertised = { ...current, features: { ...current.features, sharedTodos: { status: "supported", evidence: "advertised", reason: "The provider acknowledged the tool." } } }
  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: advertised })
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(dialog.getByText("Tool connected. A tool call has not been observed yet.")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(trigger).toHaveAttribute("aria-expanded", "false")

  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: current })
  let row = await page.evaluate(id => (window as any).agentThreadRows.find((item: any) => item.executionId === id), id)
  expect(row.capabilities.configGeneration).toBe(2)
  expect(row.capabilities.freshness).toBe("current")
  expect(row.transcript.some((event: any) => event.type === "capabilities")).toBe(false)
  expect(row.meta.activityAt).toBe(scope.activityAt)
  const actionsBefore = await page.evaluate(() => ({ sends: (window as any).agentFixture.sends.length, configs: (window as any).agentFixture.configs.length }))

  const longVersion = `build-${"v".repeat(190)}`
  const longPath = `/home/dev/${"nested/".repeat(48)}opencode`
  const longReason = "This bounded provider explanation remains readable when it needs to wrap. ".repeat(3).trim()
  const longReport = { ...current, providerRuntime: { ...current.providerRuntime, version: longVersion, executable: longPath }, features: { ...current.features, providerPlans: { ...current.features.providerPlans, reason: longReason } } }
  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: longReport })
  await trigger.click()
  await expect(dialog.getByText(longVersion, { exact: true })).toBeVisible()
  await expect(dialog.locator("code").getByText(longPath, { exact: true })).toBeVisible()
  await expect(dialog.getByText(longReason, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.keyboard.press("Escape")
  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: current })

  await page.evaluate(id => (window as any).agentFixture.emit(id, { type: "threadState", state: "connecting" }), id)
  await trigger.click()
  await expect(dialog.getByText("Checking this connection…")).toBeVisible()
  await expect(dialog.getByText("Not verified", { exact: true })).toHaveCount(4)
  await page.keyboard.press("Escape")
  await page.evaluate(id => (window as any).agentFixture.emit(id, { type: "threadState", state: "working" }), id)

  const unknownVersion = { ...current, providerRuntime: { transport: "http-v2+sse" } }
  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: unknownVersion })
  await trigger.click()
  await expect(dialog.getByText("Version not reported", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: { ...current, freshness: "stale" } })
  await page.evaluate(id => (window as any).agentFixture.emit(id, { type: "threadState", state: "detached" }), id)
  await trigger.click()
  await expect(dialog.getByText("Last observed on this connection · stale")).toBeVisible()
  await page.keyboard.press("Escape")
  await page.evaluate(id => (window as any).agentFixture.emit(id, { type: "threadState", state: "working" }), id)
  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: longReport })

  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", capabilities: value }), { id, value: report(scope, 1) })
  await page.evaluate(({ id, value }) => (window as any).agentFixture.emit(id, { type: "capabilities", attemptId: "previous-attempt", capabilities: value }), { id, value: report(scope, 3) })
  row = await page.evaluate(id => (window as any).agentThreadRows.find((item: any) => item.executionId === id), id)
  expect(row.capabilities.configGeneration).toBe(2)
  expect(row.capabilities.freshness).toBe("current")
  expect(row.transcript.some((event: any) => event.type === "capabilities")).toBe(false)
  expect(row.meta.activityAt).toBe(scope.activityAt)

  await trigger.click()
  await expect(dialog).toBeVisible()
  await expect(dialog).not.toHaveAttribute("aria-modal", "true")
  await expect(dialog.getByRole("button", { name: "Close agent details" })).toBeFocused()
  await expect(dialog.getByText("OpenCode server · HTTP/SSE")).toBeVisible()
  await expect(dialog.getByText("A Todo tool call was observed in this configuration.")).toBeVisible()
  await dialog.getByText("The agent manages task names and Done/Not done status.").scrollIntoViewIfNeeded()
  await expect(dialog.getByText("The agent manages task names and Done/Not done status.")).toBeVisible()

  await page.evaluate(() => { (window as any).agentFixture.failSnapshot = true })
  await dialog.getByRole("button", { name: "Refresh report" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("Could not refresh capability details. Try again.")
  await page.evaluate(() => { (window as any).agentFixture.failSnapshot = false })
  await dialog.getByRole("button", { name: "Close agent details" }).focus()
  await page.emulateMedia({ reducedMotion: "reduce" })

  for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 600 }, { width: 390, height: 844 }, { width: 1280, height: 520 }]) {
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await page.setViewportSize(viewport)
    await trigger.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Close agent details" })).toBeFocused()
    await expect(dialog.getByRole("button", { name: "Close agent details" })).toBeInViewport()
    await expect(dialog.getByRole("button", { name: "Refresh report" })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    expect(await dialog.evaluate(element => getComputedStyle(element).animationName)).toBe("none")
    expect(await dialog.evaluate(element => getComputedStyle(element).overflowY)).toBe("auto")
    if (viewport.height === 520) {
      expect(await dialog.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    }
  }
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(dialog).toBeVisible()
  await page.locator(".agent-context-line > span").click()
  await expect(dialog).toHaveCount(0)
  await trigger.click()
  await expect(dialog).toBeVisible()
  await page.evaluate(() => (window as any).agentFixture.replaceTransport())
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => ({ sends: (window as any).agentFixture.sends.length, configs: (window as any).agentFixture.configs.length }))).toEqual(actionsBefore)

  await page.reload()
  await expect.poll(() => page.evaluate(id => (window as any).agentThreadRows?.find((item: any) => item.executionId === id)?.capabilities?.freshness, id)).toBe("stale")
  row = await page.evaluate(id => (window as any).agentThreadRows.find((item: any) => item.executionId === id), id)
  expect(row.capabilities.configGeneration).toBe(2)
  expect(row.transcript.some((event: any) => event.type === "capabilities")).toBe(false)
})

test("discovery is stale immediately on selection changes, refreshes on demand, and ignores late old results", async ({ page }) => {
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(1)
  await page.getByRole("button", { name: "Workspace options" }).click()
  await page.getByRole("menuitem", { name: "Agent settings", exact: true }).click()
  const piSettings = page.locator(".agent-provider-setting").filter({ hasText: "Pi" })
  await piSettings.locator("summary").click()
  await expect(piSettings.getByText("Pi fixture", { exact: true })).toBeVisible()
  await expect(piSettings.getByText("Pi RPC", { exact: true })).toBeVisible()
  await expect(piSettings.getByText(/^Last checked/)).toBeVisible()
  await page.evaluate(() => { (window as any).agentFixture.deferChecks = true })
  const input = page.getByLabel("Pi executable path")

  await input.fill("")
  await input.pressSequentially("/home/dev/pi-old")
  expect(await page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(1)
  await expect(page.getByText(/^Cached ·/).first()).toBeVisible()
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(6)

  await input.focus()
  await input.fill("/home/dev/pi-new")
  expect(await page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(6)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(11)

  // Resolve the newer selection first, then prove the older result cannot replace it.
  await page.evaluate(() => (window as any).agentFixture.releaseChecks(5, 5))
  await expect(page.getByText("Installed · native connection", { exact: true })).toHaveCount(4)
  await page.evaluate(() => (window as any).agentFixture.releaseChecks(0, 5))
  await expect(page.getByText(/^Cached ·/)).toHaveCount(0)
  expect(await input.inputValue()).toBe("/home/dev/pi-new")

  // A new SSH connection generation triggers one new check without a disconnect edge.
  await page.evaluate(() => (window as any).agentFixture.replaceTransport())
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.checks.length)).toBe(16)
  await page.evaluate(() => (window as any).agentFixture.releaseChecks(10, 5))
  await expect(page.getByText("Installed · native connection", { exact: true })).toHaveCount(4)
})
