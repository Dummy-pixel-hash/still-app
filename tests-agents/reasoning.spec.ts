import { test, expect, type Page } from "@playwright/test"
import type { AgentConfigOption } from "../src/agents/types"

const effort = (names: string[], currentValue = names[0]): AgentConfigOption => ({
  id: "effort", name: "Reasoning", category: "thought_level", type: "select", currentValue,
  options: names.map(name => ({ name, value: name })),
})
const control = (page: Page) => page.getByRole("button", { name: /^Reasoning effort:/ })
async function report(page: Page, option: AgentConfigOption | null) {
  await page.evaluate(option => {
    const h = (window as any).agentFixture
    const configOptions = h.configOptions().filter((field: AgentConfigOption) => field.category !== "thought_level")
    if (option) configOptions.push(option)
    h.emit(h.current, { type: "configOptions", configOptions })
  }, option)
}

test.beforeEach(async ({ page }) => {
  await page.route("**/__impeccable/**", route => route.abort())
  await page.route("**/live.js?*", route => route.abort())
  await page.goto("/tests-agents/fixture.html?demo&scenario=models")
  await page.getByRole("button", { name: "Close model menu", exact: true }).click()
  await page.getByLabel("Message agent").focus()
})

test("reasoning is capped at four model-derived presets and Ultra is optional", async ({ page }) => {
  for (const [reported, names] of [
    [["Low", "Medium", "High"], ["Low", "Medium", "High"]],
    [["Low", "High", "Max"], ["Low", "High", "Max"]],
    [["Low", "Medium", "High", "XHigh"], ["Low", "High", "XHigh"]],
    [["None", "Minimal", "Low", "Medium", "High", "XHigh"], ["Low", "High", "XHigh"]],
    [["Minimal", "Low", "Medium", "High", "Max", "Ultra"], ["Low", "High", "Max", "Ultra"]],
    [["Quick", "Balanced", "Deep"], ["Quick", "Balanced", "Deep"]],
  ]) {
    await report(page, effort(reported, names[0]))
    const bars = control(page).locator(".agent-reasoning-level")
    await expect(bars).toHaveCount(names.length)
    expect(await bars.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-reasoning-label")))).toEqual(names)
    const heights = await bars.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
    expect(heights.every((height, index) => index === 0 || height > heights[index - 1])).toBe(true)
    const box = (await control(page).boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(38)
    for (let index = 0; index < names.length; index++) {
      await control(page).click()
      await expect(control(page)).toHaveAccessibleName(`Reasoning effort: ${names[(index + 1) % names.length]}`)
    }
    expect((await page.evaluate(() => (window as any).agentFixture.configs)).at(-1)).toEqual({ configId: "effort", value: names[0] })
  }
})

test("grouped choices and an empty-string default are preserved exactly", async ({ page }) => {
  await report(page, { ...effort([]), currentValue: "deep", options: [
    { name: "Automatic", options: [{ name: "Default", value: "" }] },
    { name: "Manual", options: [{ name: "Balanced", value: "balanced" }, { name: "Deep", value: "deep" }] },
  ] })
  await expect(control(page).locator(".agent-reasoning-level")).toHaveCount(3)
  await control(page).locator('[data-reasoning-label="Default"]').click()
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Default")
  expect((await page.evaluate(() => (window as any).agentFixture.configs)).at(-1)).toEqual({ configId: "effort", value: "" })
})

test("switching models replaces the bars and selection with that model's acknowledged choices", async ({ page }) => {
  await page.evaluate(options => { (window as any).agentFixture.reasoningByModel = options }, {
    "anthropic/claude-opus-4": effort(["Standard", "Extended"], "Extended"),
    "openai/gpt-5": effort(["Minimal", "Low", "Medium", "High", "Max", "Ultra"], "Max"),
    "google/gemini-2.5-pro": null,
  })
  for (const [model, names, selected] of [
    ["Claude Opus 4", ["Standard", "Extended"], "Extended"],
    ["GPT-5", ["Low", "High", "Max", "Ultra"], "Max"],
    ["Gemini 2.5 Pro", [], ""],
  ] as const) {
    await page.getByRole("button", { name: /^Model:/ }).click()
    await page.getByRole("option", { name: model, exact: true }).click()
    await expect(page.getByRole("button", { name: `Model: ${model}`, exact: true })).toBeEnabled()
    await expect(page.getByRole("dialog", { name: "Models", exact: true })).toHaveCount(0)
    await page.getByLabel("Message agent").focus()
    if (!names.length) await expect(control(page)).toHaveCount(0)
    else {
      await expect(control(page).locator(".agent-reasoning-level")).toHaveCount(names.length)
      expect(await control(page).locator(".agent-reasoning-level").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-reasoning-label")))).toEqual(names)
      await expect(control(page)).toHaveAccessibleName(`Reasoning effort: ${selected}`)
    }
  }
})

test("provider updates change the filled bars without sending a configuration request", async ({ page }) => {
  await report(page, effort(["Low", "Medium", "High"], "High"))
  await expect(control(page).locator(".is-filled")).toHaveCount(3)
  await report(page, effort(["Low", "Medium", "High"], "Low"))
  await expect(control(page).locator(".is-filled")).toHaveCount(1)
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Low")
  expect(await page.evaluate(() => (window as any).agentFixture.configs)).toEqual([])
})

test("Medium and High share the middle band when a higher Max tier exists", async ({ page }) => {
  const names = ["Low", "Medium", "High", "Max", "Ultra"]
  for (const [current, filled] of [["Low", 1], ["Medium", 2], ["High", 2], ["Max", 3], ["Ultra", 4]] as const) {
    await report(page, effort(names, current))
    await expect(control(page).locator(".agent-reasoning-level")).toHaveCount(4)
    await expect(control(page).locator(".is-filled")).toHaveCount(filled)
    await expect(control(page)).toHaveAccessibleName(`Reasoning effort: ${current}`)
  }
  expect(await page.evaluate(() => (window as any).agentFixture.configs)).toEqual([])
})

test("pending and rejected changes never invent a selected level or submit the draft", async ({ page }) => {
  await page.getByLabel("Message agent").fill("Keep this unsent draft")
  await page.evaluate(() => { (window as any).agentFixture.deferConfig = true })
  const high = control(page).locator('[data-reasoning-label="High"]')
  await high.click()
  await expect(page.locator(".agent-reasoning-control")).toHaveAttribute("aria-busy", "true")
  await expect(control(page)).toBeFocused()
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Medium")
  await control(page).press("Enter")
  expect(await page.evaluate(() => (window as any).agentFixture.configs)).toHaveLength(1)
  await page.evaluate(() => { const h = (window as any).agentFixture; h.deferConfig = false; h.releaseConfig() })
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: High")
  await expect(page.locator(".agent-reasoning-control")).toHaveAttribute("aria-busy", "false")
  await page.evaluate(() => { (window as any).agentFixture.rejectConfig = true })
  await control(page).locator('[data-reasoning-label="Low"]').click()
  await expect(page.locator(".agent-reasoning-control").getByRole("alert")).toContainText("The agent rejected that setting")
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: High")
  await expect(page.getByLabel("Message agent")).toHaveValue("Keep this unsent draft")
  expect(await page.evaluate(() => (window as any).agentFixture.sends)).toEqual([])
})

test("keyboard selection uses one focus target and preserves focus during updates", async ({ page }) => {
  await control(page).focus()
  await page.keyboard.press("Enter")
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: High")
  await expect(control(page)).toBeFocused()
  await page.keyboard.press("Space")
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Low")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Agent: Build", exact: true })).toBeFocused()
  expect(await page.evaluate(() => (window as any).agentFixture.sends)).toEqual([])
})

test("every bar and the surrounding hit area cycle forward once with no box", async ({ page }) => {
  await expect(control(page)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(control(page)).toHaveCSS("border-top-width", "0px")
  await control(page).hover()
  await expect(page.locator(".agent-reasoning-tooltip")).toHaveCount(0)
  await expect(control(page)).toHaveText("")
  await control(page).locator('[data-reasoning-label="Low"]').click()
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: High")
  await control(page).locator('[data-reasoning-label="High"]').click()
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Low")
  await control(page).click({ position: { x: 2, y: 2 } })
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Medium")
  expect(await page.evaluate(() => (window as any).agentFixture.configs)).toEqual([
    { configId: "effort", value: "high" }, { configId: "effort", value: "low" }, { configId: "effort", value: "medium" },
  ])
})

test("effort changes animate the bars and respect reduced motion", async ({ page }) => {
  await control(page).click()
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: High")
  const bar = control(page).locator('[data-reasoning-label="High"]')
  const durations = await bar.evaluate(el => el.getAnimations().map(animation => animation.effect?.getTiming().duration))
  expect(durations.some(duration => typeof duration === "number" && duration >= 300)).toBe(true)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await control(page).click()
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Low")
  expect(await bar.evaluate(el => el.getAnimations().length)).toBe(0)
})

test("pressing the effort selector does not bounce or scale the bars", async ({ page }) => {
  const bounds = (await control(page).boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  expect(await control(page).evaluate(el => getComputedStyle(el).transform)).toBe("none")
  expect(await control(page).locator(".agent-reasoning-level").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).transform === "none"))).toBe(true)
  await page.mouse.up()
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: High")
})

test("touch selection uses the same advertised values", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:1432", hasTouch: true, viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await page.route("**/__impeccable/**", route => route.abort())
    await page.route("**/live.js?*", route => route.abort())
    await page.goto("/tests-agents/fixture.html?demo&scenario=models")
    await page.getByRole("button", { name: "Close model menu", exact: true }).click()
    await page.getByLabel("Message agent").focus()
    const high = (await control(page).locator('[data-reasoning-label="High"]').boundingBox())!
    await page.touchscreen.tap(high.x + high.width / 2, high.y + high.height / 2)
    await expect(control(page)).toHaveAccessibleName("Reasoning effort: High")
    expect(await page.evaluate(() => (window as any).agentFixture.configs)).toEqual([{ configId: "effort", value: "high" }])
  } finally { await context.close() }
})

for (const width of [320, 390]) test(`six reported levels collapse to at most four bars at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await report(page, effort(["Default", "Minimal", "Low", "Medium", "High", "Ultra"]))
  await expect(control(page).locator(".agent-reasoning-level")).toHaveCount(4)
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible()
  const bounds = await page.locator(".agent-composer").evaluate(composer => {
    const box = composer.getBoundingClientRect()
    const controls = [...composer.querySelectorAll(".agent-model-trigger, .agent-reasoning-trigger, .agent-send")].map(node => node.getBoundingClientRect())
    return controls.every(rect => rect.left >= box.left && rect.right <= box.right)
  })
  expect(bounds).toBe(true)
})

test("missing, empty, single and unknown-current reasoning never become four fake tiers", async ({ page }) => {
  await report(page, null)
  await expect(control(page)).toHaveCount(0)
  await report(page, effort([]))
  await expect(control(page)).toHaveCount(0)
  await report(page, effort(["Automatic"]))
  await expect(control(page).locator(".agent-reasoning-level")).toHaveCount(1)
  await expect(control(page)).toHaveAttribute("aria-disabled", "true")
  await report(page, effort(["Low", "High"], "Custom"))
  await expect(control(page).locator(".agent-reasoning-level")).toHaveCount(2)
  await expect(control(page).locator('.is-filled')).toHaveCount(0)
  await expect(control(page)).toHaveAccessibleName("Reasoning effort: Custom")
})
