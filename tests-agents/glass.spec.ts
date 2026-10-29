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
  await page.goto("/")
  await page.getByRole("button", { name: "Agents", exact: true }).click()
  const results = await probeAuroraGlass(page, (name: string, image: Buffer) => info.attach(`${name}.png`, { body: image, contentType: "image/png" }))
  for (const pane of results) {
    expect(pane.unblurred, `${pane.name}: production source is visible`).toBeGreaterThan(3)
    expect(pane.ratio, `${pane.name}: real source pixels are blurred`).toBeLessThan(.3)
  }
})

test("composer and nested model menu visibly blur the backdrop rather than only tinting it", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo&scenario=models")
  await expect(page.getByRole("dialog", { name: "Model and reasoning" })).toBeVisible()
  // A high-frequency backdrop makes a missing compositor/filter visible in pixels.
  // Keep the actual production panes, layout and stacking contexts unchanged.
  await page.evaluate(() => {
    const backdrop = document.createElement("div")
    backdrop.setAttribute("aria-hidden", "true")
    backdrop.style.cssText = "position:absolute;inset:0;z-index:2;pointer-events:none;background:repeating-linear-gradient(90deg,#101014 0 6px,#e0e0e6 6px 12px)"
    document.querySelector(".agent-chat")!.prepend(backdrop)
  })
  await page.addStyleTag({ content: `
    .agent-aurora { visibility: hidden; }
    .agent-composer > * { visibility: hidden !important; }
    .agent-model-menu { visibility: visible !important; }
    .agent-model-menu > * { visibility: hidden !important; }
  ` })
  const blurred: Array<{ name: string; clip: { x: number; y: number; width: number; height: number }; image: Buffer }> = []
  for (const [name, selector] of [["composer", ".agent-composer"], ["model-menu", ".agent-model-menu"]]) {
    const bounds = await page.locator(selector).boundingBox()
    expect(bounds).not.toBeNull()
    const clip = { x: Math.ceil(bounds!.x + 18), y: Math.ceil(bounds!.y + 18), width: Math.min(200, Math.floor(bounds!.width - 36)), height: 24 }
    blurred.push({ name, clip, image: await page.screenshot({ clip, scale: "css", animations: "disabled" }) })
  }
  await page.addStyleTag({ content: ".agent-composer::before, .agent-model-menu { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" })
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

test("focusing the composer keeps its frost and tint unchanged", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-agents/fixture.html?demo")
  const composer = page.locator(".agent-composer")
  const frost = () => composer.evaluate(el => {
    const style = getComputedStyle(el, "::before")
    return { fill: style.backgroundColor, sheen: style.backgroundImage, blur: style.backdropFilter }
  })
  const before = await frost()
  expect(before.fill).toBe("rgba(28, 28, 31, 0.6)")
  expect(before.sheen).toContain("linear-gradient")
  await page.getByLabel("Message agent").focus()
  expect(await frost()).toEqual(before)
  await expect(composer).toHaveCSS("backdrop-filter", "none")
  await expect(composer).toHaveCSS("box-shadow", /rgba\(190, 92, 112,/)
})
