import { readFileSync } from "node:fs"
import { test, expect } from "@playwright/test"
import { pixelContrast, probeAuroraGlass } from "./glass-pixels.mjs"

test("the main WebView has an opaque native backing while the orb stays transparent", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  const main = config.app.windows.find((window: { label: string }) => window.label === "main")
  expect(main.transparent).toBe(false)
  expect(main.backgroundColor).toBe("#050505")
  const orb = readFileSync(new URL("../src-tauri/src/orb.rs", import.meta.url), "utf8")
  expect(orb).toContain(".transparent(true)")
  expect(orb).toContain(".background_color(tauri::webview::Color(0, 0, 0, 0))")
})

test("the real application blurs its actual aurora canvas at production depth", async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo")
  const results = await probeAuroraGlass(page, (name: string, image: Buffer) => info.attach(`${name}.png`, { body: image, contentType: "image/png" }))
  for (const pane of results) {
    expect(pane.unblurred, `${pane.name}: production source is visible`).toBeGreaterThan(3)
    expect(pane.ratio, `${pane.name}: real source pixels are blurred`).toBeLessThan(.3)
  }
})

test("native glass visibly blurs the real scene even without CSS backdrop filters", async ({ page }, info) => {
  await page.addInitScript(() => { Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} }) })
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo")
  const results = await probeAuroraGlass(page, (name: string, image: Buffer) => info.attach(`native-${name}.png`, { body: image, contentType: "image/png" }))
  for (const pane of results) {
    expect(pane.unblurred, `${pane.name}: real source is transmitted`).toBeGreaterThan(3)
    expect(pane.ratio, `${pane.name}: source is blurred without CSS filters`).toBeLessThan(.3)
  }
})

test("model menu and floating composer veil visibly blur scrolling content", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo&scenario=models")
  await expect(page.getByRole("dialog", { name: "Model and reasoning" })).toBeVisible()
  // A high-frequency backdrop makes a missing composer veil/filter visible in pixels.
  await page.evaluate(() => {
    const backdrop = document.createElement("div")
    backdrop.setAttribute("aria-hidden", "true")
    backdrop.style.cssText = "position:absolute;inset:0;z-index:2;pointer-events:none;background:repeating-linear-gradient(90deg,#101014 0 6px,#e0e0e6 6px 12px)"
    document.querySelector(".agent-chat")!.prepend(backdrop)
  })
  await page.addStyleTag({ content: `
    .agent-aurora { visibility: hidden; }
    .agent-composer-area > * { visibility: hidden !important; }
    .agent-model-menu { visibility: visible !important; }
    .agent-model-menu > * { visibility: hidden !important; }
  ` })
  const blurred: Array<{ name: string; clip: { x: number; y: number; width: number; height: number }; image: Buffer }> = []
  const composerVeil = page.locator(".agent-composer-area")
  const veilBounds = await composerVeil.boundingBox()
  expect(veilBounds).not.toBeNull()
  blurred.push({ name: "composer-veil", clip: { x: Math.ceil(veilBounds!.x + 30), y: Math.ceil(veilBounds!.y + 20), width: Math.min(200, Math.floor(veilBounds!.width - 60)), height: 24 }, image: Buffer.alloc(0) })
  for (const [name, selector] of [["model-menu", ".agent-model-menu"]]) {
    const bounds = await page.locator(selector).boundingBox()
    expect(bounds).not.toBeNull()
    const clip = { x: Math.ceil(bounds!.x + 18), y: Math.ceil(bounds!.y + 18), width: Math.min(200, Math.floor(bounds!.width - 36)), height: 24 }
    blurred.push({ name, clip, image: await page.screenshot({ clip, scale: "css", animations: "disabled" }) })
  }
  blurred[0].image = await page.screenshot({ clip: blurred[0].clip, scale: "css", animations: "disabled" })
  await page.addStyleTag({ content: ".agent-composer-area::before, .agent-model-menu { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" })
  for (const { name, clip, image } of blurred) {
    const sharp = await page.screenshot({ clip, scale: "css", animations: "disabled" })
    const sharpContrast = await pixelContrast(page, sharp)
    const blurredContrast = await pixelContrast(page, image)
    await info.attach(`${name}-contrast.json`, { body: JSON.stringify({ sharpContrast, blurredContrast }), contentType: "application/json" })
    await info.attach(`${name}-blurred.png`, { body: image, contentType: "image/png" })
    await info.attach(`${name}-unblurred.png`, { body: sharp, contentType: "image/png" })
    expect(sharpContrast, `${name}: the pane must transmit the probe, not be opaque`).toBeGreaterThan(3)
    expect(blurredContrast, `${name}: blur must remove sharp backdrop edges`).toBeLessThan(sharpContrast * .3)
  }
})

test("the composer floats without a box and the message measure is widened", async ({ page }) => {
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
  await expect(page.locator(".agent-message-list")).toHaveCSS("max-width", "960px")
  await expect(composer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(composer).toHaveCSS("border-top-width", "0px")
  await expect(area).toHaveCSS("position", "absolute")
  await expect(area).toHaveCSS("pointer-events", "none")
  expect(await area.evaluate(el => getComputedStyle(el, "::before").backdropFilter)).toBe("blur(8px)")
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
  await page.getByLabel("Message agent").focus()
  await expect(page.getByLabel("Message agent")).toHaveCSS("outline-width", "2px")
  await expect(composer).toHaveCSS("backdrop-filter", "none")
})
