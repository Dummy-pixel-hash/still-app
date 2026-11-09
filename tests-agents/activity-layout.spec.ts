import { test, expect } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/live.js?*", route => route.abort())
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/tests-agents/fixture.html?demo&layout=split")
  await page.locator(".agent-recent").first().click()
  await expect(page.locator(".agent-activity-block")).toHaveCount(3)
})

test("finished history has readable, clickable summaries rather than empty rails", async ({ page }) => {
  const rails = page.locator(".agent-activity-rail")
  const summaries = page.locator(".agent-activity-summary")
  await expect(summaries).toHaveCount(3)
  for (let index = 0; index < 3; index++) {
    await expect(rails.nth(index)).toHaveAttribute("aria-expanded", "false")
    await expect(summaries.nth(index)).toBeVisible()
    await expect(summaries.nth(index)).not.toHaveText(/^\s*$/)
    await expect(summaries.nth(index)).not.toContainText(/\b(?:Steps|Done|Complete)\b/)
    const controls = await rails.nth(index).getAttribute("aria-controls")
    expect(controls).toBeTruthy()
    await expect(page.locator(`[id="${controls}"]`)).toBeHidden()
  }

  await summaries.first().click()
  await expect(rails.first()).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(".agent-activity-event-list").first().locator(":scope > *")).toHaveCount(5)
  await expect(page.locator(".agent-activity-block").first().locator(".agent-activity-summary")).toHaveCount(0)
})

test("the accepted hierarchy uses the chosen typography without Live preview scaffolding", async ({ page }) => {
  await expect(page.locator(".agent-chat > .agent-conversation--hierarchy")).toHaveCount(1)
  await expect(page.locator(".agent-message-list")).toHaveCount(1)
  await expect(page.locator("[data-impeccable-variants], [data-impeccable-carbonize], [data-impeccable-variant], style[data-impeccable-css]")).toHaveCount(0)
  const response = page.locator(".agent-message-assistant .agent-prose")
  await expect(response).toHaveCSS("font-size", "15px")
  await expect(response).toHaveCSS("line-height", "26.25px")
  await expect(response.locator("h3")).toHaveCSS("font-size", "19px")
  await expect(response.locator("h3")).toHaveCSS("font-weight", "625")
  await expect(page.locator(".agent-message-assistant .agent-message-author")).toHaveCSS("font-size", "12px")
  await expect(page.locator(".agent-user-text")).toHaveCSS("font-size", "14px")
  await expect(page.locator(".agent-activity-layout")).toHaveCSS("gap", "6px")
})

test("side lines are visible only while their activity group is expanded", async ({ page }) => {
  const rail = page.locator(".agent-activity-rail").first()
  const line = rail.locator(":scope > span")
  await expect(line).toBeHidden()
  await rail.hover()
  await expect(line).toBeHidden()

  await page.locator(".agent-activity-summary").first().click()
  await expect(rail).toHaveAttribute("aria-expanded", "true")
  await expect(line).toBeVisible()

  await rail.click()
  await expect(rail).toHaveAttribute("aria-expanded", "false")
  await expect(line).toBeHidden()
  await expect(page.locator(".agent-activity-summary").first()).toBeVisible()
})

test("all five-item groups stay expanded until the turn actually finishes", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "userMessage", text: "Continue the review" })
    for (let index = 0; index < 5; index++) fixture.emit(fixture.current, {
      type: "toolStart", toolCallId: `continuation-${index}`, title: `Inspect file ${index + 1}`, status: "completed",
      content: [{ type: "content", content: { type: "text", text: `Contents of file ${index + 1}` } }],
    })
  })
  await expect(page.locator(".agent-activity-block")).toHaveCount(4)
  const firstRail = page.locator(".agent-activity-rail").nth(3)
  await expect(firstRail).toHaveAttribute("aria-expanded", "true")

  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "reasoningChunk", text: "The next chunk must not close the earlier work." })
  })
  await expect(page.locator(".agent-activity-block")).toHaveCount(5)
  await expect(firstRail).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(".agent-activity-rail").nth(4)).toHaveAttribute("aria-expanded", "true")

  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "assistantChunk", text: "The initial checks look good. I will verify one more case." })
    fixture.emit(fixture.current, { type: "reasoningChunk", text: "A prose update is not turn completion either." })
  })
  await expect(page.locator(".agent-activity-block")).toHaveCount(6)
  for (let index = 3; index < 6; index++) await expect(page.locator(".agent-activity-rail").nth(index)).toHaveAttribute("aria-expanded", "true")

  await page.evaluate(() => (window as any).agentFixture.finish())
  await expect(page.locator(".agent-activity-summary")).toHaveCount(6)
  for (const rail of await page.locator(".agent-activity-rail").all()) await expect(rail).toHaveAttribute("aria-expanded", "false")
  for (const line of await page.locator(".agent-activity-rail > span").all()) await expect(line).toBeHidden()
})

test("reopened activity remains open across metadata updates and supports keyboard toggling", async ({ page }) => {
  const summary = page.locator(".agent-activity-summary").first()
  const rail = page.locator(".agent-activity-rail").first()
  await summary.focus()
  await page.keyboard.press("Enter")
  await expect(rail).toHaveAttribute("aria-expanded", "true")
  await expect(rail).toBeFocused()
  await page.evaluate(() => (window as any).agentFixture.finish())
  await expect(rail).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Space")
  await expect(rail).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator(".agent-activity-summary").first()).toBeVisible()
})

test("failed or unfinished tool output is not hidden by auto-collapse", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "userMessage", text: "Check the build" })
    fixture.emit(fixture.current, { type: "toolStart", toolCallId: "failed-build", title: "Run build", status: "failed", content: [{ type: "content", content: { type: "text", text: "Build failed: missing export" } }] })
    fixture.finish()
  })
  await expect(page.locator(".agent-activity-rail").last()).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(".agent-tool-body").last()).toContainText("Build failed: missing export")

  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "userMessage", text: "Check a long-running command" })
    fixture.emit(fixture.current, { type: "toolStart", toolCallId: "unfinished-build", title: "Await build output", status: "running" })
    fixture.finish()
  })
  const rail = page.locator(".agent-activity-rail").last()
  await expect(rail).toHaveAttribute("aria-expanded", "true")
  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "toolUpdate", toolCallId: "unfinished-build", status: "completed" })
  })
  await expect(rail).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator(".agent-activity-summary").last()).toContainText("Await build output")
})

for (const layout of ["chapters", "timeline", "split"]) {
  test(`${layout}: summaries, rails, and expanded tool output do not overlap`, async ({ page }) => {
    await page.getByLabel("Choose activity layout").selectOption(layout)
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 900], [390, 844], [320, 640]]) {
      await page.setViewportSize({ width, height })
      const rails = page.locator(".agent-activity-rail")
      for (let index = 0; index < await rails.count(); index++) {
        const rail = rails.nth(index)
        if (await rail.getAttribute("aria-expanded") !== "true") await rail.click()
        await expect(rail).toHaveAttribute("aria-expanded", "true")
      }

      const geometry = await page.locator(".agent-activity-block").evaluateAll(blocks => blocks.map(block => {
        const content = block.querySelector(".agent-activity-content")!.getBoundingClientRect()
        const rail = block.querySelector(".agent-activity-rail")!.getBoundingClientRect()
        const box = block.getBoundingClientRect()
        const events = [...block.querySelector(".agent-activity-event-list")!.children].map(el => {
          const rect = el.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        })
        return { top: box.top, bottom: box.bottom, railRight: rail.right, railBottom: rail.bottom, contentLeft: content.left, contentRight: content.right, events }
      }))
      for (let index = 0; index < geometry.length; index++) {
        const block = geometry[index]
        expect(block.contentLeft).toBeGreaterThanOrEqual(block.railRight)
        expect(block.railBottom).toBeLessThanOrEqual(block.bottom + 1)
        if (index > 0) expect(block.top).toBeGreaterThanOrEqual(geometry[index - 1].bottom - 1)
        for (let eventIndex = 0; eventIndex < block.events.length; eventIndex++) {
          const item = block.events[eventIndex]
          expect(item.left).toBeGreaterThanOrEqual(block.contentLeft - 1)
          expect(item.right).toBeLessThanOrEqual(block.contentRight + 1)
          for (const other of block.events.slice(eventIndex + 1)) {
            expect(item.right <= other.left + 1 || other.right <= item.left + 1 || item.bottom <= other.top + 1 || other.bottom <= item.top + 1).toBe(true)
          }
        }
      }
      expect(await page.locator(".agent-conversation").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await expect(page.locator(".agent-tool-heading").getByText("Done", { exact: true })).toHaveCount(0)
    }
    // A collapsed group must still have a real row, not a line spilling into its neighbour.
    for (const rail of await page.locator(".agent-activity-rail").all()) await rail.click()
    await expect(page.locator(".agent-activity-summary")).toHaveCount(3)
    const collapsed = await page.locator(".agent-activity-block").evaluateAll(blocks => blocks.map(el => {
      const rect = el.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, height: rect.height, railBottom: el.querySelector(".agent-activity-rail")!.getBoundingClientRect().bottom }
    }))
    for (let index = 0; index < collapsed.length; index++) {
      expect(collapsed[index].height).toBeGreaterThanOrEqual(34)
      expect(collapsed[index].railBottom).toBeLessThanOrEqual(collapsed[index].bottom + 1)
      if (index > 0) expect(collapsed[index].top).toBeGreaterThanOrEqual(collapsed[index - 1].bottom)
    }
  })
}

test("split view uses two columns only when the conversation itself has enough space", async ({ page }) => {
  const rail = page.locator(".agent-activity-rail").last()
  await rail.click()
  const events = page.locator(".agent-activity-event-list").last()
  await expect(events).toHaveCSS("grid-template-columns", /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/)
  await page.setViewportSize({ width: 960, height: 768 })
  await expect(events).toHaveCSS("grid-template-columns", /^\d+(?:\.\d+)?px$/)
})

test("the final response and change summary remain reachable above the floating composer", async ({ page }) => {
  for (const [width, height] of [[1440, 900], [960, 768], [768, 900], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height })
    await expect.poll(async () => {
      await page.locator(".agent-conversation").evaluate(el => { el.scrollTop = el.scrollHeight })
      const changes = await page.locator(".agent-change-summary").boundingBox()
      const composer = await page.locator(".agent-composer-area").boundingBox()
      return !!changes && !!composer && changes.y + changes.height <= composer.y
    }).toBe(true)
    await expect(page.locator(".agent-change-summary")).toBeInViewport()
  }
})

test("long tool names, commands, and unbroken output stay inside their split columns", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "userMessage", text: "Inspect unusually long output" })
    for (let index = 0; index < 2; index++) fixture.emit(fixture.current, {
      type: "toolStart", toolCallId: `long-output-${index}`, title: "Run the project's complete cross-platform integration verification command with extended logging",
      rawInput: { command: `node scripts/${"verification-".repeat(20)}.mjs` }, status: "completed",
      content: [{ type: "content", content: { type: "text", text: "output/" + "unbroken".repeat(250) } }],
    })
  })
  for (const width of [1440, 960, 390, 320]) {
    await page.setViewportSize({ width, height: 800 })
    const overflows = await page.locator(".agent-activity-block").last().evaluate(block => {
      const bounds = block.getBoundingClientRect()
      return [...block.querySelectorAll(".agent-tool-heading, .agent-tool-body, .agent-tool-body > pre")].filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
      }).map(el => el.className)
    })
    expect(overflows).toEqual([])
    expect(await page.locator(".agent-conversation").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
})
