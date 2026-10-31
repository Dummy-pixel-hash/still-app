import { test, expect, type Page } from "@playwright/test"

interface Stats {
  hasHost: boolean
  hasScreen: boolean
  transform: string | null
  screenW: number
  screenH: number
  hostW: number
  hostH: number
  withinHost: boolean
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
  // The scaled grid fits the card's actual available height and width.
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
  const before = (await stats(page)).snapshotText
  await page.evaluate(() => (window as any).harness.remount())
  // Filter/sort/move remounts every card: the preview must still paint.
  await expect.poll(async () => (await stats(page)).cardText).toContain("READY")
  const s = await stats(page)
  expect(s.hasScreen).toBe(true)
  expect(s.transform).not.toBeNull()
  expect(s.snapshotText).toBe(before)
})

for (const columns of [1, 2, 3]) {
  test(`wide, short screen fits its own card in a ${columns}-column grid`, async ({ page }) => {
    await page.evaluate((columns) => {
      const h = (window as any).harness
      h.layout(columns, columns === 1 ? 340 : 1000)
      h.surface(120, 5)
    }, columns)
    await emit(page, "\x1b[2J\x1b[H" + "x".repeat(120))
    await expect.poll(async () => (await stats(page)).cardText).toContain("x".repeat(120))
    await expect.poll(async () => {
      const s = await stats(page)
      const scale = scaled(s.transform)
      return scale > 0 && s.withinHost && s.screenW * scale <= s.hostW + 1 && s.screenH * scale <= s.hostH + 1
    }).toBe(true)
    const s = await stats(page)
    expect(s.screenW * scaled(s.transform)).toBeGreaterThan(s.hostW * 0.95)
  })
}

test("card refits when grid columns change without new output", async ({ page }) => {
  await page.evaluate(() => (window as any).harness.surface(120, 5))
  await emit(page, "\x1b[2J\x1b[H" + "x".repeat(120))
  await expect.poll(async () => (await stats(page)).cardText).toContain("x".repeat(120))
  for (const columns of [3, 2, 1]) {
    await page.evaluate((n) => (window as any).harness.layout(n, 1000), columns)
    await expect.poll(async () => {
      const s = await stats(page)
      return Math.abs(s.screenW * scaled(s.transform) - s.hostW)
    }).toBeLessThan(1)
  }
})

test("output continues while a card is filtered out", async ({ page }) => {
  await page.evaluate(() => (window as any).harness.show(false))
  await expect(page.locator("[data-preview-host]")).toHaveCount(0)
  await emit(page, "\r\nBACKGROUND READY")
  await page.evaluate(() => (window as any).harness.show(true))
  await expect(page.locator("[data-preview-host] .xterm-rows")).toContainText("BACKGROUND READY")
})

test("silent geometry changes rebuild without blanking the last frame", async ({ page }) => {
  await emit(page, "x".repeat(120) + "\r\nREADY")
  const rows = page.locator("[data-preview-host] .xterm-rows")
  await expect(rows).toContainText("READY")
  const during = await page.evaluate(() => {
    const before = document.querySelector("[data-preview-host] .xterm-rows")?.textContent
    ;(window as any).harness.surface(60, 16)
    return { before, after: document.querySelector("[data-preview-host] .xterm-rows")?.textContent }
  })
  expect(during.after).toBe(during.before)
  await expect(rows.locator(":scope > div")).toHaveCount(16)
  await expect(rows).toContainText("READY")
  expect((await stats(page)).snapshotText.split("\n").slice(1, 3)).toEqual(["x".repeat(60), "x".repeat(60)])
  // A later font change must refit the replacement screen, not observe the
  // disposed terminal's DOM forever.
  const before = await stats(page)
  await page.evaluate(() => (window as any).harness.font(20))
  await expect.poll(async () => (await stats(page)).screenH).toBeGreaterThan(before.screenH)
  await expect.poll(async () => {
    const s = await stats(page)
    return s.screenW * scaled(s.transform) <= s.hostW + 1 && s.screenH * scaled(s.transform) <= s.hostH + 1
  }).toBe(true)
})

test("alternate-screen cursor redraws and Unicode remain live", async ({ page }) => {
  await emit(page, "\x1b[?1049h\x1b[2J\x1b[H┌─ 状态 🚀 ─┐\x1b[3;8Hprogress 10%\x1b[3;8H\x1b[Kprogress 90%\x1b[20;90HEND")
  await expect(page.locator("[data-preview-host] .xterm-rows")).toContainText("progress 90%")
  const s = await stats(page)
  expect(s.snapshotText).toContain("状态 🚀")
  expect(s.snapshotText).toContain("END")
  expect(s.snapshotText).not.toContain("progress 10%")
  expect(s.snapshotText).toBe(s.referenceText)
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

test("disconnect saves the latest screen inside the persistence throttle window", async ({ page }) => {
  await emit(page, wide())
  await expect
    .poll(async () => (await stats(page)).snapshotText)
    .toContain("READY")
  const before = await stats(page)
  await page.evaluate(() => (window as any).harness.disconnect())
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
  // Reload with no reconnect: only the persisted snapshot can paint, and it
  // must use the ORIGINAL grid, not the classic 80x24 miniature.
  await page.goto("/tests-terminal/card-fixture.html?no-boot=1")
  const frozenText = (await page.locator("[data-preview-host] .card-mini").textContent()) ?? ""
  expect(frozenText).toContain("READY")
  expect(frozenText).toContain("x".repeat(50))
  const frozenEl = page.locator("[data-preview-host] [data-cols]")
  expect(await frozenEl.getAttribute("data-cols")).toBe(String(before.cols))
  await expect.poll(async () => {
    const s = await stats(page)
    return scaled(s.transform) > 0 && s.withinHost && s.screenW * scaled(s.transform) <= s.hostW + 1 && s.screenH * scaled(s.transform) <= s.hostH + 1
  }).toBe(true)
})

test("remote disconnect flushes the latest snapshot too", async ({ page }) => {
  await emit(page, "\r\nREMOTE FINAL")
  await expect(page.locator("[data-preview-host] .xterm-rows")).toContainText("REMOTE FINAL")
  await page.evaluate(() => (window as any).harness.status("disconnected"))
  await expect.poll(() => page.evaluate(() => (window as any).harness.frozen()?.lines.join("\n"))).toContain("REMOTE FINAL")
})

test("disconnect during parsing persists the completed final frame", async ({ page }) => {
  await page.evaluate(async () => {
    const h = (window as any).harness
    h.emit("\x1b[2J\x1b[H" + "working\r\n".repeat(3000) + "FINAL FRAME")
    await h.disconnect()
  })
  await expect.poll(() => page.evaluate(() => (window as any).harness.frozen()?.lines.join("\n"))).toContain("FINAL FRAME")
  await page.goto("/tests-terminal/card-fixture.html?no-boot=1")
  await expect(page.locator("[data-preview-host] [data-frozen-screen]")).toContainText("FINAL FRAME")
})

test("a cleared screen stays blank after disconnect and reload", async ({ page }) => {
  await emit(page, "\x1b[2J\x1b[H")
  await expect.poll(async () => (await stats(page)).snapshotText).toBe("")
  await page.evaluate(() => (window as any).harness.disconnect())
  await expect.poll(() => page.evaluate(() => (window as any).harness.frozen()?.lines)).toEqual([])
  await page.goto("/tests-terminal/card-fixture.html?no-boot=1")
  await expect(page.locator("[data-preview-host] [data-frozen-screen]")).toBeEmpty()
})

test("a connected session with no output does not show an old saved screen", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("still.preview.screen.v2.card-fixture", "still-frozen:1 100x20\nOLD SESSION"))
  await page.goto("/tests-terminal/card-fixture.html?no-boot=1")
  await expect(page.locator("[data-preview-host] [data-frozen-screen]")).toContainText("OLD SESSION")
  await page.evaluate(() => (window as any).harness.connect())
  await expect(page.locator("[data-preview-host] .card-preview-body")).not.toContainText("OLD SESSION")
  await emit(page, "NEW SESSION")
  await expect(page.locator("[data-preview-host] .xterm-rows")).toContainText("NEW SESSION")
})
