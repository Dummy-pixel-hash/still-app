import { readFileSync } from "node:fs"
import { test, expect } from "@playwright/test"
import { pixelContrast, probeAuroraGlass } from "./glass-pixels.mjs"

test("Windows WebView uses sRGB to avoid washed-out wide-gamut colors", () => {
  const windows = JSON.parse(readFileSync(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"))
  const windowsMain = windows.app.windows.find((window: { label: string }) => window.label === "main")
  expect(windowsMain.additionalBrowserArgs).toContain("--force-color-profile=srgb")
  // Setting custom browser args replaces Wry's defaults, so preserve them.
  expect(windowsMain.additionalBrowserArgs).toContain("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection")
})

test("the main WebView has an opaque native backing while the orb stays transparent", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  const main = config.app.windows.find((window: { label: string }) => window.label === "main")
  expect(main.transparent).toBe(false)
  expect(main.backgroundColor).toBe("#050505")
  const orb = readFileSync(new URL("../src-tauri/src/orb.rs", import.meta.url), "utf8")
  expect(orb).toContain(".transparent(true)")
  expect(orb).toContain(".background_color(tauri::webview::Color(0, 0, 0, 0))")
})

test("browser preview keeps CSS backdrop blur instead of the native canvas fallback", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto("/tests-agents/fixture.html?demo")
  const workspace = page.locator(".agent-workspace")
  await expect(workspace).not.toHaveAttribute("data-native-shell", "true")
  await expect(workspace).not.toHaveAttribute("data-frost-rendered", "true")
  await expect(page.locator(".agent-sidebar")).toHaveCSS("backdrop-filter", /blur/)
  await expect.poll(() => page.locator(".agent-composer").evaluate(el => getComputedStyle(el, "::before").backdropFilter)).toContain("blur")
})

test("native workspace panes blur with their shared frost texture without CSS backdrop filters", async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  })
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.goto("/tests-agents/fixture.html?demo")
  await page.addStyleTag({ content: ".agent-workspace *, .agent-workspace *::before { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" })
  await expect.poll(() => page.locator(".agent-workspace").getAttribute("data-frost-rendered")).toBe("true")
  const results = await probeAuroraGlass(page, (name: string, image: Buffer) => info.attach(`native-${name}.png`, { body: image, contentType: "image/png" }))
  for (const pane of results) {
    expect(pane.unblurred, `${pane.name}: native scene texture is visible`).toBeGreaterThan(3)
    expect(pane.ratio, `${pane.name}: shared frost texture blurs in native mode`).toBeLessThan(.3)
  }
  await expect(page.locator(".agent-sidebar")).toHaveAttribute("data-agent-frost", "")
  await expect(page.locator(".agent-workspace")).toHaveAttribute("data-frost-rendered", "true")
  const readPixels = () => page.locator(".agent-aurora canvas").evaluate(canvas => Number(canvas.dataset.frostPixels))
  await expect.poll(readPixels).toBeGreaterThan(0)
  expect(await readPixels(), "native blur surface is bounded to 48k pixels; DPR does not multiply work").toBeLessThanOrEqual(48_000)
})

test("the floating input and model menu keep their own CSS blur while the wrapper stays clear", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo&scenario=models")
  await expect(page.getByRole("dialog", { name: "Models", exact: true })).toBeVisible()
  // Keep the production layout. The stripes distinguish a blurred pill from
  // a merely tinted rectangle and from the fully clear space around it.
  await page.evaluate(() => {
    const backdrop = document.createElement("div")
    backdrop.setAttribute("aria-hidden", "true")
    backdrop.style.cssText = "position:absolute;inset:0;z-index:2;pointer-events:none;background:repeating-linear-gradient(90deg,#101014 0 6px,#e0e0e6 6px 12px)"
    document.querySelector(".agent-chat")!.prepend(backdrop)
  })
  await page.addStyleTag({ content: `
    .agent-aurora { visibility: hidden; }
    .agent-composer textarea, .agent-composer-footnote, .agent-composer-provider, .agent-composer-actions { visibility: hidden !important; }
    .agent-composer .agent-model-trigger { opacity: 0 !important; pointer-events: none !important; }
    .agent-model-menu { visibility: visible !important; }
    .agent-model-menu > * { opacity: 0 !important; pointer-events: none !important; }
  ` })
  const wrapper = page.locator(".agent-composer-area"), composer = page.locator(".agent-composer")
  await expect(wrapper).toHaveCSS("position", "absolute")
  await expect(wrapper).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  expect(await wrapper.evaluate(el => getComputedStyle(el, "::before").content)).toBe("none")
  const bounds = await composer.boundingBox(), outer = await wrapper.boundingBox()
  const clearClip = { x: Math.ceil(outer!.x + 4), y: Math.ceil(bounds!.y + 22), width: Math.floor(bounds!.x - outer!.x - 10), height: 24 }
  const clear = await page.screenshot({ clip: clearClip, scale: "css" })
  expect(await pixelContrast(page, clear), "the wrapper must not paint a black footer").toBeGreaterThan(10)

  const panes = []
  for (const [name, selector] of [["composer", ".agent-composer"], ["model-menu", ".agent-model-menu"]]) {
    const box = await page.locator(selector).boundingBox()
    const clip = { x: Math.ceil(box!.x + 20), y: Math.ceil(box!.y + 20), width: Math.min(200, Math.floor(box!.width - 40)), height: 24 }
    const image = await page.screenshot({ clip, scale: "css", animations: "disabled" })
    await info.attach(`${name}-blurred.png`, { body: image, contentType: "image/png" })
    panes.push({ name, clip, contrast: await pixelContrast(page, image) })
  }
  await page.addStyleTag({ content: ".agent-composer::before, .agent-model-menu { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" })
  for (const pane of panes) {
    const sharp = await page.screenshot({ clip: pane.clip, scale: "css", animations: "disabled" })
    const contrast = await pixelContrast(page, sharp)
    await info.attach(`${pane.name}-unblurred.png`, { body: sharp, contentType: "image/png" })
    expect(contrast).toBeGreaterThan(3)
    expect(pane.contrast, `${pane.name} retains its blur`).toBeLessThan(contrast * .3)
  }
})

test("the frosted input floats over a wide transcript and reserves space as the draft grows", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo")
  await page.locator(".agent-recent").first().click()
  await page.evaluate(() => {
    const fixture = (window as any).agentFixture
    fixture.emit(fixture.current, { type: "userMessage", text: "Lay out a long implementation report" })
    fixture.emit(fixture.current, { type: "assistantChunk", text: Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1}: preserve ownership, report progress, and keep the existing message available while it scrolls behind the floating composer.`).join("\n\n") })
    fixture.finish()
  })
  const composer = page.locator(".agent-composer")
  const area = page.locator(".agent-composer-area")
  await expect(composer).toHaveClass(/is-collapsed/)
  await expect(composer).toHaveCSS("border-radius", "999px")
  await expect(composer).toHaveCSS("max-width", "360px")
  await expect(composer.locator(".agent-composer-provider")).toBeHidden()
  await expect(composer.locator(".agent-model-trigger-copy strong")).toHaveText("Model A")
  await expect(composer.locator(".agent-model-trigger-copy small")).toBeHidden()
  await expect(composer.getByLabel("Commands and skills")).toBeHidden()
  await expect(composer.getByLabel("Send message")).toBeVisible()
  await composer.click({ position: { x: 5, y: 20 } })
  await expect(composer).not.toHaveClass(/is-collapsed/)
  await expect(page.locator(".agent-message-list")).toHaveCSS("max-width", "960px")
  await expect(composer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(composer).toHaveCSS("border-top-width", "0px")
  await expect(composer).toHaveCSS("border-radius", "14px")
  expect(await composer.evaluate(el => getComputedStyle(el, "::before").backdropFilter)).toBe("blur(24px) saturate(1.12)")
  await expect(area).toHaveCSS("position", "absolute")
  await expect(area).toHaveCSS("pointer-events", "none")
  expect(await area.evaluate(el => getComputedStyle(el, "::before").content)).toBe("none")
  const layout = await page.evaluate(() => {
    const chat = document.querySelector(".agent-chat").getBoundingClientRect()
    const viewport = document.querySelector(".agent-conversation").getBoundingClientRect()
    const area = document.querySelector(".agent-composer-area").getBoundingClientRect()
    return { areaBottomGap: Math.abs(chat.bottom - area.bottom), viewportBottomGap: Math.abs(viewport.bottom - chat.bottom), viewportHeight: viewport.height }
  })
  expect(layout.areaBottomGap).toBeLessThan(2)
  expect(layout.viewportBottomGap).toBeLessThan(2)
  expect(layout.viewportHeight).toBeGreaterThan(500)
  await expect.poll(() => page.locator(".agent-conversation").evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500)
  const viewport = page.locator(".agent-conversation")
  await viewport.evaluate(el => { el.scrollTop = 0 })
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBe(0)
  await viewport.evaluate(el => { el.scrollTop = 400 })
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(100)
  const initialHeight = (await area.boundingBox())!.height
  await page.getByLabel("Message agent").fill("Keep this multiline draft while the chat scrolls.\n".repeat(12))
  await expect.poll(async () => (await area.boundingBox())!.height).toBeGreaterThan(initialHeight + 50)
  await expect.poll(() => page.evaluate(() => {
    const dock = document.querySelector(".agent-composer-area")!.getBoundingClientRect()
    const viewport = document.querySelector(".agent-conversation")!
    return parseFloat(getComputedStyle(viewport).paddingBottom) - dock.height
  })).toBeGreaterThanOrEqual(22)
  await page.getByRole("button", { name: "Latest activity" }).click()
  await expect.poll(() => page.evaluate(() => {
    const last = document.querySelector(".agent-message-list")!.lastElementChild!.getBoundingClientRect()
    const pill = document.querySelector(".agent-composer")!.getBoundingClientRect()
    return pill.top - last.bottom
  })).toBeGreaterThan(10)
  await page.getByLabel("Message agent").focus()
  await expect.poll(() => composer.evaluate(el => getComputedStyle(el, "::before").backdropFilter)).toContain("blur")
})

test("expanding the collapsed composer settles at its final width without a height jump", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  await page.locator(".agent-recent").first().click()
  await page.getByRole("button", { name: "Find a message" }).focus()
  const composer = page.locator(".agent-composer")
  const textarea = page.getByLabel("Message agent")
  await expect(composer).toHaveClass(/is-collapsed/)
  await composer.click({ position: { x: 5, y: 20 } })
  await expect(composer).not.toHaveClass(/is-collapsed/)
  await expect.poll(() => textarea.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(700)
  await expect.poll(() => textarea.evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(90)
  await page.waitForTimeout(300)
  const settled = await textarea.evaluate(el => el.getBoundingClientRect().height)
  expect((await composer.boundingBox())!.height).toBeLessThan(200)
  await textarea.fill("A short line")
  await expect.poll(() => textarea.evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(settled, 0)
})

for (const width of [1456, 620, 390]) test(`composer expansion never overshoots before the first keystroke at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await page.goto("/tests-agents/fixture.html?demo")
  await page.locator(".agent-recent").first().click()
  await page.getByRole("button", { name: "Find a message" }).focus()
  await expect(page.locator(".agent-composer")).toHaveClass(/is-collapsed/)
  const frames = await page.evaluate(async () => {
    const composer = document.querySelector<HTMLElement>(".agent-composer")!
    const textarea = composer.querySelector("textarea")!
    const frames: Array<{ inputHeight: number; width: number; height: number }> = []
    textarea.focus()
    for (let index = 0; index < 24; index++) {
      await new Promise(requestAnimationFrame)
      if (!composer.classList.contains("is-collapsed")) frames.push({ inputHeight: textarea.offsetHeight, width: composer.offsetWidth, height: composer.offsetHeight })
    }
    return frames
  })
  expect(frames).toHaveLength(24)
  const final = frames.at(-1)!
  expect(Math.max(...frames.map(frame => frame.inputHeight))).toBeLessThanOrEqual(final.inputHeight + 1)
  expect(Math.max(...frames.map(frame => frame.width)) - Math.min(...frames.map(frame => frame.width))).toBeLessThanOrEqual(1)
  await page.getByLabel("Message agent").fill("A short first line")
  expect(await page.getByLabel("Message agent").evaluate(el => el.offsetHeight)).toBe(final.inputHeight)
})

test("a wrapped draft resizes to the new viewport without waiting for another keystroke", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/tests-agents/fixture.html?demo")
  await page.locator(".agent-recent").first().click()
  const textarea = page.getByLabel("Message agent")
  const draft = "Keep this wrapped draft. ".repeat(10)
  await textarea.fill(draft)
  const narrowHeight = await textarea.evaluate(el => el.offsetHeight)
  expect(narrowHeight).toBeGreaterThan(100)
  await page.setViewportSize({ width: 1456, height: 844 })
  await expect.poll(() => textarea.evaluate(el => el.offsetHeight)).toBeLessThan(narrowHeight - 30)
  await expect(textarea).toHaveValue(draft)
})

test("the glass shell animates without scaling text or changing its measured height", async ({ page }) => {
  await page.goto("/tests-agents/fixture.html?demo")
  await page.locator(".agent-recent").first().click()
  await page.getByRole("button", { name: "Find a message" }).focus()
  const samples = await page.evaluate(async () => {
    const composer = document.querySelector<HTMLElement>(".agent-composer")!
    const textarea = composer.querySelector("textarea")!
    textarea.focus()
    const samples: Array<{ height: number; shell: string; scale: number }> = []
    for (let index = 0; index < 36; index++) {
      await new Promise(requestAnimationFrame)
      const transform = getComputedStyle(textarea).transform
      samples.push({ height: textarea.offsetHeight, shell: getComputedStyle(composer, "::before").transform, scale: new DOMMatrixReadOnly(transform === "none" ? undefined : transform).a })
    }
    return samples
  })
  expect(samples.some(sample => sample.shell !== "none")).toBe(true)
  expect(new Set(samples.map(sample => sample.height)).size).toBe(1)
  expect(samples.every(sample => sample.scale === 1)).toBe(true)
  expect(samples.at(-1)!.shell).toBe("none")
  expect(await page.locator(".agent-composer").evaluate(el => getComputedStyle(el, "::before").borderTopColor)).toBe("rgba(255, 255, 255, 0.2)")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.getByRole("button", { name: "Find a message" }).focus()
  await page.getByLabel("Message agent").focus()
  expect(await page.locator(".agent-composer").evaluate(el => getComputedStyle(el, "::before").transform)).toBe("none")
})

test("native frost tracks the active composer after history opens and viewport resizes", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo")
  await page.locator(".agent-recent").first().click()
  await page.setViewportSize({ width: 1100, height: 480 })
  await expect(page.locator(".agent-chat")).not.toHaveClass(/is-launch/)
  const composer = page.locator(".agent-composer")
  await expect(composer).toHaveAttribute("data-agent-frost", "")
  await expect(page.locator(".agent-workspace")).toHaveAttribute("data-frost-rendered", "true")
  await page.getByLabel("Message agent").focus()
  await expect(composer).toHaveAttribute("data-agent-frost", "")
})
