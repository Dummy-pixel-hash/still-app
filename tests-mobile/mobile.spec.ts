import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style")
      style.textContent = "#impeccable-live-global-bar{display:none!important}"
      document.head.append(style)
    }, { once: true })
  })
  await page.goto("/tests-mobile/fixture.html")
})

test("phone launches a real thread library, not the desktop workspace", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Minimize", exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Still workspace" })).toHaveCount(0)
  await expect(page.locator(".mobile-thread-row")).toHaveCount(3)
  await page.getByRole("button", { name: /Needs you/ }).first().click()
  await expect(page.locator(".mobile-thread-row")).toHaveCount(1)
  await expect(page.locator(".mobile-thread-row")).toContainText("Refine project navigation")
})

test("all root destinations use the floating mobile dock", async ({ page }) => {
  for (const name of ["Terminals", "Settings", "Agents"]) {
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click()
    await expect(page.getByRole("navigation", { name: "Main navigation" }).locator('[aria-current="page"]')).toHaveAttribute("aria-label", name)
  }
  await expect(page.locator(".mobile-navigation")).toHaveCSS("border-radius", "36px")
})

test("mobile page fades simply while the dock updates, respecting reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  const dock = page.getByRole("navigation", { name: "Main navigation" })
  await dock.getByRole("button", { name: "Terminals", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Terminals", exact: true })).toBeVisible()
  await expect(dock.getByRole("button", { name: "Terminals", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.locator(".mobile-page-panel")).toHaveCSS("animation-name", "mobile-page-enter")
  await expect(dock.getByRole("button", { name: "Terminals", exact: true })).toHaveCSS("transition-duration", /0\.18s/)
  await dock.getByRole("button", { name: "Agents", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await page.locator(".mobile-thread-row").first().click()
  await expect(page.getByRole("heading", { name: "Refine project navigation", exact: true })).toBeVisible()
  await expect(page.locator(".mobile-root-content")).toHaveCSS("transition-duration", /0\.15s/)
  await expect(page.locator(".agent-workspace--mobile")).toHaveCSS("animation-name", "mobile-detail-enter")
  await page.getByRole("dialog", { name: "Authenticate Fixture server", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await dock.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible()
  await expect(page.locator(".mobile-page-panel")).toHaveCSS("animation-name", "none")
  await expect(dock.getByRole("button", { name: "Settings", exact: true })).toHaveCSS("transition-duration", "0s")
})

test("mobile creation and Enter preserve an unsent draft", async ({ page }) => {
  await page.getByRole("button", { name: "New task", exact: true }).click()
  await expect(page.locator(".agent-workspace--mobile")).toBeVisible()
  await expect(page.locator(".agent-sidebar")).toHaveCount(0)
  await page.getByRole("textbox", { name: "Message agent", exact: true }).fill("A task for the phone")
  await page.getByRole("textbox", { name: "Message agent", exact: true }).press("Enter")
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toHaveValue("A task for the phone\n")
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "New task", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toHaveValue("A task for the phone\n")
})

test("new-task controls stay readable and tappable at phone widths", async ({ page }) => {
  await page.getByRole("button", { name: "New task", exact: true }).click()
  const toolbar = page.locator(".agent-composer-toolbar")
  await expect(toolbar).toBeVisible()
  for (const width of [413, 360]) {
    await page.setViewportSize({ width, height: 915 })
    const controls = page.locator(".agent-composer-controls > .agent-picker, .agent-composer-controls > .agent-reasoning-control, .agent-composer-actions > button")
    const boxes = await controls.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
    }))
    expect(boxes.length).toBeGreaterThan(1)
    for (const box of boxes) expect(box.width).toBeGreaterThan(0)
    for (let first = 0; first < boxes.length; first++) for (let second = first + 1; second < boxes.length; second++) {
      const a = boxes[first], b = boxes[second]
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      expect(overlapX > 1 && overlapY > 1, `controls overlap at ${width}px: ${JSON.stringify({ a, b })}`).toBe(false)
    }
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCSS("width", "48px")
  }
})

test("the mock thread opens with a distilled model-and-agent chat pill", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?chatpill=Refine%20project%20navigation")
  const composer = page.locator(".agent-composer")
  await expect(page.getByRole("heading", { name: "Refine project navigation", exact: true })).toBeVisible()
  await expect(composer.locator("textarea")).toHaveValue("Make the project list easier to scan.")
  const model = composer.getByRole("button", { name: "Model: GPT-5 Codex", exact: true })
  await expect(model).toBeVisible()
  await expect(model).toContainText("OpenCode")
  await expect(model).toContainText("GPT-5 Codex")
  await expect(model).toHaveCSS("opacity", "1")
  await expect(composer.locator(".agent-composer-toolbar")).toBeVisible()
  await expect(composer.getByRole("button", { name: "Agent: Code", exact: true })).toBeVisible()
  await expect(composer.getByRole("button", { name: "Reasoning effort: High", exact: true })).toBeVisible()
  const positions = await composer.locator(".agent-model-picker, .agent-mode-picker, .agent-reasoning-control, .agent-composer-actions > button").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }))
  for (let first = 0; first < positions.length; first++) for (let second = first + 1; second < positions.length; second++) {
    const a = positions[first], b = positions[second]
    expect(Math.min(a.right, b.right) <= Math.max(a.left, b.left) + 1 || Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top) + 1).toBe(true)
  }
})

test("offline mobile preview can compose and send a clearly simulated message", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/tests-mobile/fixture.html?chatpill=Refine%20project%20navigation&emptydraft")
  const composer = page.locator(".agent-composer")
  const message = page.getByRole("textbox", { name: "Message agent", exact: true })
  const send = page.getByRole("button", { name: "Send message", exact: true })
  await expect(composer).toHaveClass(/is-collapsed/)
  await composer.getByRole("button", { name: "Write a message", exact: true }).click()
  await expect(message).toBeFocused()
  await expect(send).toBeDisabled()
  await message.fill("Check the mobile preview")
  await expect(send).toBeEnabled()
  await send.click()
  await expect(page.getByRole("article", { name: "Your simulated message" })).toHaveText("Check the mobile preview")
  await expect(page.getByRole("article", { name: "Simulated response" })).toContainText("Preview simulation · offline")
  await expect(page.getByRole("article", { name: "Simulated response" })).toContainText("No SSH connection or agent was used.")
  await expect(message).toHaveValue("")
  await expect(send).toBeHidden()
  await expect(composer).toHaveClass(/is-collapsed/)
  await composer.getByRole("button", { name: "Write a message", exact: true }).click()
  await expect(message).toBeFocused()
  await expect(composer.getByRole("button", { name: "Model: GPT-5 Codex", exact: true })).toContainText("OpenCode")
  await expect(composer.getByRole("button", { name: "Agent: Code", exact: true })).toBeVisible()
  await expect(composer.getByRole("button", { name: "Reasoning effort: High", exact: true })).toBeVisible()
})

test("an empty mobile thread has a one-row pill that expands and folds without empty grid rows", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.locator(".mobile-thread-row").first().click()
  await page.getByRole("dialog", { name: "Authenticate Fixture server", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click()
  const composer = page.locator(".agent-composer")
  const model = composer.getByRole("button", { name: "Model: GPT-5 Codex", exact: true })
  const message = composer.getByRole("textbox", { name: "Message agent", exact: true })
  for (const width of [320, 360, 413]) {
    await page.setViewportSize({ width, height: 915 })
    await expect(composer).toHaveClass(/is-collapsed/)
    await expect(model.locator(".agent-composer-provider")).toBeVisible()
    await expect(model.locator(".agent-composer-provider .agent-sr-only")).toHaveCSS("clip-path", "none")
    const folded = await composer.boundingBox()
    expect(folded?.height).toBeLessThanOrEqual(60)
    await expect(composer.getByRole("button", { name: "Send message", exact: true })).toBeHidden()
    await composer.getByRole("button", { name: "Write a message", exact: true }).click()
    await expect(composer).not.toHaveClass(/is-collapsed/)
    await expect(message).toBeFocused()
    await expect(message).toHaveCSS("opacity", "1")
    await expect(composer.getByRole("button", { name: "Agent: Code", exact: true })).toBeVisible()
    await expect(composer.getByRole("button", { name: "Reasoning effort: High", exact: true })).toBeVisible()
    await expect(composer.getByRole("button", { name: "Send message", exact: true })).toBeVisible()
    // Focus/border-color CSS transitions are fine; the desktop shell morph and
    // delayed text fade must not run on a phone, including with motion enabled.
    expect(await composer.evaluate(element => element.getAnimations({ subtree: true })
      .filter(animation => animation.constructor.name === "Animation").length)).toBe(0)
    const boxes = await composer.locator(".agent-model-picker, .agent-mode-picker, .agent-reasoning-control, .agent-composer-actions > button").evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }))
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(width)
    }
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      expect(Math.min(boxes[a].right, boxes[b].right) <= Math.max(boxes[a].left, boxes[b].left) + 1 || Math.min(boxes[a].bottom, boxes[b].bottom) <= Math.max(boxes[a].top, boxes[b].top) + 1).toBe(true)
    }
    await message.fill("Keep this unsent.")
    await page.locator(".mobile-agent-header h1").click()
    await expect(composer).not.toHaveClass(/is-collapsed/)
    await message.fill("")
    await page.locator(".mobile-agent-header h1").click()
    await expect(composer).toHaveClass(/is-collapsed/)
  }
})

test("opening a thread reuses its actual persisted conversation", async ({ page }) => {
  await page.locator('.mobile-thread-row').filter({ hasText: "Fix reconnect after sleep" }).click()
  await expect(page.getByRole("heading", { name: "Fix reconnect after sleep", exact: true })).toBeVisible()
  await expect(page.locator(".agent-user-text")).toContainText("Keep the remote work intact.")
  await expect(page.locator(".mobile-navigation")).toBeHidden()
  const auth = page.getByRole("dialog", { name: "Authenticate Fixture server", exact: true })
  await expect(auth).toBeVisible()
  await auth.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
})

test("empty phone has no fabricated projects or conversations", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?empty")
  await expect(page.locator(".mobile-thread-row")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "A place for your next idea." })).toBeVisible()
  await page.getByRole("button", { name: /Add a project/ }).click()
  await expect(page.getByRole("dialog", { name: "Choose a project", exact: true })).toBeVisible()
})

test("a remote server can be added without creating a terminal project or saving secrets", async ({ page }) => {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: /Add a server/ }).click()
  await expect(page.getByRole("heading", { name: "Add a remote server", exact: true })).toBeVisible()
  await page.getByLabel("Server address").fill("build.example.test")
  await page.getByLabel("SSH port").fill("2222")
  await page.getByLabel("Username").fill("mobile-dev")
  await page.getByLabel("Display name Optional").fill("Build box")
  await page.getByRole("combobox", { name: "Authentication", exact: true }).selectOption("key")
  await page.getByRole("button", { name: "Save server", exact: true }).click()
  const chooser = page.getByRole("dialog", { name: "Projects and servers", exact: true })
  await expect(chooser.getByRole("button", { name: /Build box mobile-dev@build\.example\.test:2222/ })).toBeVisible()
  await expect(chooser.getByText("mobile-dev@build.example.test:2222")).toBeVisible()
  await expect(chooser.getByRole("button", { name: /Add a remote project/ })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("still.m2.store.v1") || "{\"sessions\":[]}").sessions)).toHaveLength(0)
  await chooser.getByRole("button", { name: /Add a remote project/ }).click()
  const projectPicker = page.getByRole("dialog", { name: "Choose a project", exact: true })
  await expect(projectPicker.getByRole("combobox", { name: "Project server" })).toContainText("mobile-dev@build.example.test")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await page.getByRole("button", { name: "Manage projects and servers", exact: true }).click()
  await page.getByRole("button", { name: /Actions for Build box/ }).click()
  await page.getByRole("button", { name: "Edit server details", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Edit server", exact: true })).toBeVisible()
  await expect(page.getByLabel("Server address")).toHaveValue("build.example.test")
  await page.getByLabel("Display name Optional").fill("Build staging")
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  const updated = page.getByRole("dialog", { name: "Projects and servers", exact: true })
  await expect(updated.getByRole("button", { name: /Build staging mobile-dev@build\.example\.test:2222/ })).toBeVisible()
  await updated.getByRole("button", { name: /Actions for Build staging/ }).click()
  await page.getByRole("button", { name: "Remove server", exact: true }).click()
  await page.getByRole("alertdialog", { name: "Remove Build staging", exact: true }).getByRole("button", { name: "Remove server", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Projects and servers", exact: true }).getByRole("button", { name: /Build staging/ })).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("still.m2.store.v1") || "{\"sessions\":[]}").sessions)).toHaveLength(0)
})

test("compact mobile screens keep dock and primary actions inside the viewport", async ({ page }) => {
  for (const [width, height] of [[320, 568], [393, 852], [412, 915]]) {
    await page.setViewportSize({ width, height })
    await expect(page.locator(".mobile-navigation")).toBeInViewport()
    await expect(page.getByRole("button", { name: "New task", exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
