import { test, expect } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/live.js?*", route => route.abort())
  await page.emulateMedia({ reducedMotion: "reduce" })
})

test("returning users can compose beside all three recent conversations", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 896 })
  await page.goto("/tests-agents/fixture.html?demo")
  const chat = page.locator(".agent-chat.is-launch.has-recents")
  await expect(chat).toHaveCSS("display", "grid")
  const composer = await page.locator(".agent-composer-area").boundingBox()
  const recents = await page.locator(".agent-recents").boundingBox()
  expect(recents!.x).toBeGreaterThan(composer!.x + composer!.width)
  for (const recent of await page.locator(".agent-recent").all()) await expect(recent).toBeInViewport()
  await page.getByLabel("Message agent").fill("Keep the original composer behavior")
  await expect(page.getByLabel("Message agent")).toHaveValue("Keep the original composer behavior")
  await page.locator(".agent-recent").first().click()
  await expect(page.locator(".agent-chat")).not.toHaveClass(/is-launch/)
  await expect(page.locator(".agent-chat")).toHaveCSS("display", "flex")
  await expect(page.locator(".agent-composer-area")).not.toHaveClass(/is-compact/)
})

test("compact launch layouts stack without horizontal overflow", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  for (const [width, height] of [[1100, 720], [800, 720], [390, 844], [320, 560]]) {
    await page.setViewportSize({ width, height })
    const composer = await page.locator(".agent-composer-area").boundingBox()
    const recents = await page.locator(".agent-recents").boundingBox()
    const welcome = await page.locator(".agent-welcome").boundingBox()
    expect(composer!.y).toBeGreaterThanOrEqual(welcome!.y + welcome!.height)
    expect(recents!.y).toBeGreaterThanOrEqual(composer!.y + composer!.height)
    expect(await page.locator(".agent-chat").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.locator(".agent-recent").last().scrollIntoViewIfNeeded()
    await expect(page.locator(".agent-recent").last()).toBeInViewport()
  }
})

test("the first-run and archived views retain their existing layouts", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html")
  await expect(page.locator(".agent-chat.is-launch")).not.toHaveClass(/has-recents/)
  await expect(page.locator(".agent-chat")).toHaveCSS("display", "flex")
  await expect(page.getByLabel("Message agent")).toBeVisible()
  await page.goto("/tests-agents/fixture.html?demo")
  await page.getByRole("button", { name: "Archived", exact: true }).click()
  await expect(page.locator(".agent-chat")).not.toHaveClass(/is-launch/)
  await expect(page.locator(".agent-chat")).toHaveCSS("display", "flex")
})

test("the compact launch composer removes hint chrome and preserves accessible controls", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  await expect(page.locator(".agent-composer-area")).toHaveClass(/is-compact/)
  await expect(page.getByLabel("Message agent")).toHaveCSS("min-height", "48px")
  await expect(page.getByLabel("Message agent")).toHaveAccessibleDescription("Enter to send. Shift+Enter for a new line. Type / for commands.")
  await expect(page.locator(".agent-composer-hint")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Coding agent: OpenCode", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Commands and skills", exact: true })).toBeVisible()
  await expect(page.locator(".agent-choose-project")).toBeVisible()
  await page.getByLabel("Message agent").fill("/")
  await expect(page.locator(".agent-command-menu")).toBeVisible()
})

test("the compact sidebar preserves complete titles, search, and selected-state hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 896 })
  await page.goto("/tests-agents/fixture.html?demo")
  const panel = page.locator(".agent-sidebar-panel")
  await expect(panel.locator(".agent-storage-status")).toHaveCount(0)
  const title = panel.locator(".agent-thread-title").first()
  await expect(title).toHaveCSS("font-size", "13.65px")
  await expect(title).toHaveCSS("font-weight", "400")
  await expect(title).toHaveCSS("white-space", "nowrap")
  await expect(title).toHaveCSS("text-overflow", "ellipsis")
  await expect(panel.locator(".agent-thread-time").first()).toHaveCSS("font-size", "11.55px")
  for (const row of await panel.locator(".agent-thread-open").all()) await expect(row).toBeInViewport()
  await expect(panel.locator(".agent-thread-open").first()).toHaveAttribute("title", /^Refine project navigation · OpenCode · Saved/)
  await panel.getByRole("textbox", { name: "Search conversations", exact: true }).fill("keyboard")
  await expect(panel.locator(".agent-thread-title")).toHaveCount(1)
  await expect(panel.locator(".agent-thread-title")).toHaveText("Add keyboard shortcuts")
  await panel.getByRole("textbox", { name: "Search conversations", exact: true }).fill("")
  await expect(panel.locator(".agent-thread-title")).toHaveCount(8)
  await panel.locator(".agent-thread-open").first().click()
  await expect(panel.locator(".agent-thread.is-selected .agent-thread-title")).toHaveCSS("font-weight", "500")
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
})

test("the launch headline leads with the product's serif display voice", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 896 })
  await page.goto("/tests-agents/fixture.html?demo")
  const heading = page.getByRole("heading", { name: "What will you build?" })
  await expect(heading).toHaveCSS("font-family", /Instrument Serif/)
  await expect(heading).toHaveCSS("font-size", "46.2px")
  await expect(heading).toHaveCSS("font-weight", "400")
  await expect(heading).toHaveCSS("line-height", "51.744px")
  await expect(heading.locator("em")).toHaveCSS("font-style", "italic")
  await expect(heading).toHaveAccessibleName("What will you build?")
  await expect(page.locator(".agent-welcome > p,.agent-welcome-symbol,.agent-launch-note")).toHaveCount(0)
  await expect(page.locator(".agent-welcome")).toBeInViewport()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(heading).toHaveCSS("font-size", "33px")
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false)
})

test("the particle horizon sits behind genuinely frosted writing and history surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 896 })
  await page.goto("/tests-agents/fixture.html?demo")
  const chat = page.locator(".agent-chat.is-launch.has-recents")
  const welcomePane = chat.locator(":scope > .agent-conversation")
  const recentPane = chat.locator(".agent-recents")
  await expect(welcomePane).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(welcomePane).toHaveCSS("box-shadow", "none")
  await expect(welcomePane).toHaveCSS("backdrop-filter", "none")
  await expect(recentPane).toHaveCSS("background-color", "rgba(18, 18, 21, 0.48)")
  await expect(recentPane).toHaveCSS("border-radius", "14px")
  await expect(recentPane).toHaveCSS("backdrop-filter", "blur(20px) saturate(1.1)")
  await expect(chat.locator(".agent-composer")).toHaveCSS("backdrop-filter", "none")
  expect(await chat.locator(".agent-composer").evaluate(el => getComputedStyle(el, "::before").backdropFilter)).toBe("blur(24px) saturate(1.12)")
  await expect(chat.locator(".agent-composer")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(chat.locator(".agent-starters button").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(recentPane.locator(".agent-section-label > span")).toHaveText("Recent conversations")
  await expect(recentPane.locator(".agent-recent > img")).toHaveCount(0)
  await page.getByLabel("Message agent").fill("Use the frosted workspace")
  await expect(page.getByLabel("Message agent")).toHaveValue("Use the frosted workspace")
  await chat.locator(".agent-recent").first().click()
  await expect(page.locator(".agent-chat")).not.toHaveClass(/is-launch/)

  await page.goto("/tests-agents/fixture.html?demo")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(".agent-chat.is-launch.has-recents > .agent-conversation")).toHaveCSS("box-shadow", "none")
  await expect(page.locator(".agent-chat.is-launch.has-recents .agent-recents")).toHaveCSS("border-top-width", "1px")
  expect(await page.locator(".agent-chat").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
})

test("Agents keeps a black foundation and a horizontal particle aurora behind accessible controls", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 896 })
  await page.goto("/tests-agents/fixture.html?demo")
  const workspace = page.locator(".agent-workspace")
  const palette = await workspace.evaluate(el => {
    const style = getComputedStyle(el)
    const sidebar = getComputedStyle(el.querySelector(".agent-sidebar")!)
    const main = getComputedStyle(el.querySelector(".agent-main")!)
    const dust = getComputedStyle(el.querySelector(".agent-aurora")!)
    return {
      bg: style.getPropertyValue("--ag-bg").trim(),
      accent: style.getPropertyValue("--ag-accent").trim(),
      background: style.backgroundImage,
      dust: dust.backgroundImage,
      dustOpacity: dust.opacity,
      dustAnimation: dust.animationName,
      dustPointerEvents: dust.pointerEvents,
      dustZIndex: dust.zIndex,
      sidebarFilter: sidebar.backdropFilter,
      mainBackground: main.backgroundColor,
      mainRadius: main.borderRadius,
      mainFilter: main.backdropFilter,
      composerFilter: getComputedStyle(el.querySelector(".agent-composer")!, "::before").backdropFilter,
      composerText: getComputedStyle(el.querySelector(".agent-welcome h1")!).color,
    }
  })
  expect(palette.bg).toBe("#050505")
  expect(palette.accent).toBe("#f06870")
  expect(palette.background).toBe("none")
  expect(palette.dust).toBe("none")
  expect(palette.dustOpacity).toBe("0.65")
  expect(palette.dustAnimation).toBe("none")
  expect(palette.dustPointerEvents).toBe("none")
  expect(palette.dustZIndex).toBe("-1")
  expect(palette.sidebarFilter).toBe("blur(24px) saturate(1.1)")
  expect(palette.mainBackground).toBe("rgba(0, 0, 0, 0)")
  expect(palette.mainRadius).toBe("0px")
  expect(palette.mainFilter).toBe("none")
  expect(palette.composerFilter).toBe("blur(24px) saturate(1.12)")
  expect(palette.composerText).toBe("rgb(237, 237, 237)")
  await expect(workspace.getByRole("textbox", { name: "Search conversations" })).toBeVisible()
  await expect(workspace.getByLabel("Message agent")).toBeVisible()
  await expect(workspace.getByRole("button", { name: "Agent settings" })).toBeVisible()
  const aurora = workspace.locator(".agent-aurora")
  await expect(aurora).toHaveAttribute("aria-hidden", "true")
  await expect(aurora).toHaveAttribute("data-rendered", "true")
  const fieldBounds = await aurora.boundingBox()
  expect(fieldBounds!.width / fieldBounds!.height).toBeGreaterThan(3)
  const asset = await page.request.get("/agents/particle-aurora.svg")
  expect(asset.ok()).toBe(true)
  const drawing = await asset.text()
  expect(drawing.match(/<circle /g)).toHaveLength(1185)
  expect(drawing).not.toMatch(/<path|<line|<polyline/)

  for (const [width, height] of [[1100, 720], [800, 720], [390, 844], [320, 560]]) {
    await page.setViewportSize({ width, height })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1)).toBe(true)
  }
})

test("radiating particles animate individually and pause for reduced motion or a hidden window", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  const aurora = page.locator(".agent-aurora")
  const canvas = aurora.locator("canvas")
  await expect(aurora).toHaveCSS("pointer-events", "none")
  await expect(aurora).toHaveAttribute("data-paused", "true")
  const pixels = () => canvas.evaluate(el => (el as HTMLCanvasElement).toDataURL())
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(aurora).toHaveAttribute("data-paused", "false")
  const runningFrame = await pixels()
  await expect.poll(pixels).not.toBe(runningFrame)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(aurora).toHaveAttribute("data-paused", "true")
  const stillFrame = await pixels()
  await page.waitForTimeout(150)
  expect(await pixels()).toBe(stillFrame)

  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(aurora).toHaveAttribute("data-paused", "false")
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(aurora).toHaveAttribute("data-paused", "true")
  const hiddenFrame = await pixels()
  await page.waitForTimeout(150)
  expect(await pixels()).toBe(hiddenFrame)
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden")
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(aurora).toHaveAttribute("data-paused", "false")
  const heading = page.getByRole("heading", { name: "What will you build?" })
  expect(await heading.evaluate(el => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return hit === el || el.contains(hit)
  })).toBe(true)
  await page.getByLabel("Message agent").fill("Keep the task editable")
  await expect(page.getByLabel("Message agent")).toHaveValue("Keep the task editable")
})

test("dense fluid dust stays bounded and batches particles into four paint operations", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  const metrics = await page.evaluate(async () => {
    const path = "/src/agents/auroraRenderer.ts"
    const { createAuroraRenderer } = await import(path)
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")!
    const originalFill = context.fill.bind(context)
    let fills = 0
    context.fill = (...args: Parameters<typeof context.fill>) => { fills++; return originalFill(...args) }
    const renderer = createAuroraRenderer(canvas)!
    const results = []
    for (const [width, height] of [[1232, 323], [405, 250], [4000, 340]]) {
      renderer.resize(width, height, 3)
      fills = 0
      renderer.draw(.25)
      results.push({ width, ...renderer.metrics(), fills })
    }
    return results
  })
  expect(metrics[0].particles).toBeGreaterThan(9000)
  expect(metrics[1].particles).toBe(3600)
  expect(metrics[2].particles).toBe(12000)
  for (const metric of metrics) {
    expect(metric.fills).toBe(4)
    expect(metric.gasWidth).toBeLessThanOrEqual(176)
    expect(metric.gasHeight).toBe(56)
    expect(metric.backingPixels).toBeLessThanOrEqual(900000)
  }
  await expect(page.locator(".agent-aurora canvas")).toHaveCount(1)
})

test("a static particle horizon remains available when canvas cannot initialize", async ({ page }) => {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
  })
  await page.goto("/tests-agents/fixture.html?demo")
  const aurora = page.locator(".agent-aurora")
  await expect(aurora).toHaveAttribute("data-rendered", "false")
  await expect(aurora).toHaveCSS("background-image", /particle-aurora\.svg/)
  await expect(page.getByLabel("Message agent")).toBeVisible()
  await page.getByLabel("Message agent").fill("The fallback does not block input")
  await expect(page.getByLabel("Message agent")).toHaveValue("The fallback does not block input")
})

test("starter prompts remain useful as quiet text actions without icon or pill chrome", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 896 })
  await page.goto("/tests-agents/fixture.html?demo")
  const starters = page.locator(".agent-starters")
  const buttons = starters.locator("button")
  await expect(buttons).toHaveCount(3)
  await expect(buttons.first()).toHaveCSS("border-radius", "2px")
  await expect(buttons.first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(starters).toHaveCSS("gap", "18px")
  await expect(starters.locator("button > svg")).toHaveCount(0)
  for (const button of await buttons.all()) await expect(button).toBeInViewport()
  await expect(buttons).toHaveText(["Build a feature", "Explore the code", "Review changes"])
  await buttons.first().hover()
  await expect(buttons.first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(buttons.first()).toHaveCSS("color", "rgb(238, 238, 238)")
  await expect(buttons.first()).toHaveCSS("transform", "none")
  await page.getByLabel("Message agent").fill("/")
  await expect(buttons.first()).toBeDisabled()
  await expect(buttons.first()).toHaveCSS("opacity", "0.45")
})

test("the sidebar is a rounded glass pane and keeps search, selection, collapse and mobile focus", async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 896 })
  await page.goto("/tests-agents/fixture.html?demo")
  const sidebar = page.locator(".agent-sidebar")
  const topbar = page.locator(".agent-topbar")
  await expect(sidebar).toHaveCSS("width", "280px")
  await expect(sidebar).toHaveCSS("margin-left", "8px")
  await expect(sidebar).toHaveCSS("margin-top", "8px")
  await expect(sidebar).toHaveCSS("border-radius", "16px")
  await expect(sidebar).toHaveCSS("border-top-width", "0px")
  await expect(sidebar).toHaveCSS("backdrop-filter", "blur(24px) saturate(1.1)")
  await expect(topbar).toHaveCSS("backdrop-filter", "blur(24px) saturate(1.1)")
  await expect(topbar).toHaveCSS("height", "44px")
  await expect(topbar).toHaveCSS("margin-top", "10px")
  await expect(topbar).toHaveCSS("border-radius", "12px")
  await expect(sidebar.locator(".agent-sidebar-new")).toHaveCSS("border-radius", "11px")
  await sidebar.getByRole("textbox", { name: "Search conversations", exact: true }).fill("keyboard")
  await expect(sidebar.locator(".agent-thread-title")).toHaveText("Add keyboard shortcuts")
  await sidebar.getByRole("textbox", { name: "Search conversations", exact: true }).fill("")
  await sidebar.locator(".agent-thread-open").first().click()
  const selected = sidebar.locator(".agent-thread.is-selected")
  await expect(selected).toHaveCSS("background-image", /linear-gradient\(110deg/)
  await expect(selected).toHaveCSS("box-shadow", /rgba\(255, 255, 255,/)
  await page.getByRole("button", { name: "Collapse project sidebar" }).click()
  await expect(sidebar).toHaveCSS("width", "56px")
  await expect(sidebar.locator(".agent-sidebar-rail .agent-rail-new")).toHaveCSS("color", "rgb(237, 181, 192)")
  await page.getByRole("button", { name: "Expand project sidebar" }).click()
  await expect(sidebar).toHaveCSS("width", "280px")

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(topbar).toHaveCSS("height", "46px")
  await expect(topbar).toHaveCSS("margin-top", "8px")
  await page.getByRole("button", { name: "Toggle projects" }).click()
  await expect(sidebar).toBeVisible()
  await expect(sidebar).toHaveCSS("left", "8px")
  await expect(sidebar).toHaveCSS("border-radius", "16px")
  await expect(sidebar).toHaveCSS("backdrop-filter", "blur(30px) saturate(1.12)")
  await page.keyboard.press("Escape")
  await expect(sidebar).toBeHidden()
  await expect(page.getByRole("button", { name: "Toggle projects" })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
