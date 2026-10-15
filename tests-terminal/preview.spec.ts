import { test, expect, type Page } from "@playwright/test"

interface Stats {
  hasHost: boolean
  hasScreen: boolean
  transform: string | null
  screenW: number
  screenH: number
  hostW: number
  hostH: number
  cardText: string
  snapshotText: string
  referenceText: string
  cols: number
  rows: number
}

const stats = (page: Page) =>
  page.evaluate(() => (window as any).harness.stats()) as Promise<Stats>
const emit = (page: Page, text: string) =>
  page.evaluate((t) => (window as any).harness.emit(t), text)
const scaled = (t: string | null): number => Number(/scale\(([\d.]+)\)/.exec(t ?? "")?.[1] ?? 0)
const wide = (n = 50) => "x".repeat(n) + "\nREADY"

test.beforeEach(async ({ page }) => {
  await page.goto("/tests-terminal/card-fixture.html")
  await page.waitForFunction(() => (window as any).harness?.stats().hasScreen === true)
})

test("card renders the session's real grid, not a miniature reflow", async ({ page }) => {
  // The fixture declares 100x20 as the real surface (below the 120 cap): the
  // preview must adopt it as-is. READY pins the replay so nothing is mid-parse.
  await emit(page, wide())
  await expect
    .poll(async () => (await stats(page)).snapshotText)
    .toContain("READY")
  const s = await stats(page)
  expect({ cols: s.cols, rows: s.rows }).toEqual({ cols: 100, rows: 20 })
  // Byte-for-byte replay through an identically sized emulator wraps the same.
  expect(s.snapshotText).toBe(s.referenceText)
  // The rendered DOM trails the buffer by a paint frame; poll for it.
  await expect.poll(async () => (await stats(page)).cardText).toContain("READY")
})

test("miniature is a geometric shrink that fits the card viewport", async ({ page }) => {
  await emit(page, wide())
  await expect
    .poll(async () => (await stats(page)).snapshotText)
    .toContain("READY")
  const s = await stats(page)
  const scale = scaled(s.transform)
  expect(scale).toBeGreaterThan(0.05)
  // The scaled grid fits both the fixed viewport height and the card width.
  expect(s.screenH * scale).toBeLessThanOrEqual(s.hostH + 1)
  expect(s.screenW * scale).toBeLessThanOrEqual(s.hostW + 1)
  // And it fills a meaningful part of the viewport, not a postage stamp.
  expect(s.screenH * scale).toBeGreaterThan(s.hostH * 0.5)
})

test("card remount re-homes the live terminal instead of rendering blank", async ({ page }) => {
  await emit(page, wide())
  await expect
    .poll(async () => (await stats(page)).snapshotText)
    .toContain("READY")
  await page.evaluate(() => (window as any).harness.remount())
  // Filter/sort/move remounts every card: the preview must still paint.
  await expect.poll(async () => (await stats(page)).cardText).toContain("READY")
  const s = await stats(page)
  expect(s.hasScreen).toBe(true)
  expect(s.transform).not.toBeNull()
})

test("geometry change rebuilds and re-wraps at the new size", async ({ page }) => {
  // 120 continuous x's (no hard breaks): 100+20 at 100 cols, 60+60 at 60.
  // Same bytes, different wrap — proves the rebuild replays, not resizes.
  await emit(page, "x".repeat(120) + "\r\nREADY")
  await expect
    .poll(async () => (await stats(page)).cardText)
    .toContain("READY")
  const wide = await stats(page)
  // Pre-resize proof: identical geometry through an identical emulator.
  expect(wide.snapshotText).toBe(wide.referenceText)
  await page.evaluate(() => (window as any).harness.surface(60, 16))
  await emit(page, "\r\nNARROW")
  // Poll the RENDERED card: a repaint only happens after the store notifies a
  // COMPLETE frame, so seeing the post-resize token in the DOM proves the
  // rebuild+replay finished at the new grid.
  await expect
    .poll(async () => {
      const s = await stats(page)
      return s.cols === 60 && s.cardText.includes("NARROW")
    })
    .toBe(true)
  const narrow = await stats(page)
  expect({ cols: narrow.cols, rows: narrow.rows }).toEqual({ cols: 60, rows: 16 })
  const lines = narrow.snapshotText.split("\n")
  // Row 0 is the fixture's boot line; the 120 x's re-wrapped to two full rows.
  expect(lines.slice(1, 3)).toEqual(["x".repeat(60), "x".repeat(60)])
})

test("huge surfaces are capped to the preview maximum", async ({ page }) => {
  await page.evaluate(() => (window as any).harness.surface(400, 120))
  await emit(page, "x".repeat(140) + "\nREADY")
  await expect
    .poll(async () => (await stats(page)).snapshotText)
    .toContain("READY")
  const s = await stats(page)
  expect(s.cols).toBe(120)
  expect(s.rows).toBe(32)
})

test("disconnect keeps the frozen screen at its original layout", async ({ page }) => {
  // The boot persist claims the throttle window first, so the interesting
  // snapshot lands on the NEXT window — emit a cue and wait for it.
  await emit(page, wide())
  await expect
    .poll(async () => (await stats(page)).snapshotText)
    .toContain("READY")
  const before = await stats(page)
  // Force the persist gate open (the boot snapshot otherwise owns the 2s
  // throttle window) and confirm the CURRENT screen was snapshotted.
  await page.evaluate(() => (window as any).harness.freezeNow())
  await expect
    .poll(async () => {
      const f = (await page.evaluate(() => (window as any).harness.frozen())) as
        | { lines: string[] }
        | null
      return f?.lines.join("\n") ?? ""
    })
    .toContain("READY")
  const frozen = (await page.evaluate(() => (window as any).harness.frozen())) as {
    cols: number
    rows: number
    lines: string[]
  }
  // Same wrap as the live screen (same grid), not a 64-col miniature reflow.
  expect(frozen.lines.join("\n")).toContain("x".repeat(50))
  expect(frozen.cols).toBe(before.cols)
  await page.evaluate(() => (window as any).harness.disconnect())
  // Reload with no reconnect: only the persisted snapshot can paint, and it
  // must use the ORIGINAL grid, not the classic 80x24 miniature.
  await page.goto("/tests-terminal/card-fixture.html?no-boot=1")
  const frozenText = (await page.locator("[data-preview-host] .card-mini").textContent()) ?? ""
  expect(frozenText).toContain("READY")
  expect(frozenText).toContain("x".repeat(50))
  const frozenEl = page.locator("[data-preview-host] [data-cols]")
  expect(await frozenEl.getAttribute("data-cols")).toBe(String(before.cols))
})
