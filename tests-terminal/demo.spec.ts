import { test, expect, type Page } from "@playwright/test"

const previewUrl = "/?preview=terminal"
const previewStoreKey = "still.preview.terminals.store.v1"

async function terminalText(page: Page, id: string) {
  return page.evaluate(async id => {
    const modulePath = "/src/session/connections.ts"
    const { terminalForSession } = await import(modulePath)
    const buffer = terminalForSession(id).buffer.active
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) || "").join("\n")
  }, id)
}

test.beforeEach(async ({ page }) => {
  await page.route("**/live.js?*", route => route.abort())
  await page.emulateMedia({ reducedMotion: "reduce" })
})

test("terminal preview has sample projects, live screens, and working terminal input", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(previewUrl)
  await expect(page.locator("[data-card]")).toHaveCount(8)
  await expect(page.getByRole("heading", { name: "Infrastructure", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Lab", exact: true })).toBeVisible()
  await expect(page.getByText("Terminal preview · local simulation", { exact: true })).toBeVisible()
  const web = page.locator('[data-card="preview-terminal-web"]')
  await expect(web.locator(".xterm-rows")).toContainText("VITE")
  await expect(page.locator('[data-card="preview-terminal-tests"] .xterm-rows')).toContainText("35 passed")
  await expect(page.locator('[data-card="preview-terminal-notes"]')).toContainText("Detached")
  await expect(page.locator('[data-card="preview-terminal-notes"] .xterm-rows')).toContainText("Next session")
  await page.getByRole("button", { name: "Open Web · dev server on dev.preview.invalid", exact: true }).click()
  const input = page.locator("#still-term-preview-terminal-web .xterm-helper-textarea")
  await expect(input).toBeFocused()
  await expect.poll(() => terminalText(page, "preview-terminal-web")).toContain("simulated output")
  await page.keyboard.type("echo preview-input-works")
  await page.keyboard.press("Enter")
  await expect.poll(() => terminalText(page, "preview-terminal-web")).toContain("\npreview-input-works\n")
  await page.keyboard.press("Control+.")
  await expect(page.locator("#still-term-preview-terminal-web")).toHaveCount(0)
  await page.getByRole("button", { name: "Open Web · dev server on dev.preview.invalid", exact: true }).click()
  await expect(input).toBeFocused()
  await expect.poll(() => terminalText(page, "preview-terminal-web")).toContain("preview-input-works")
  expect(errors).toEqual([])
})

test("preview reloads its isolated metadata without changing the real workspace", async ({ page }) => {
  const realStore = JSON.stringify({
    projects: [{ id: "real-project", name: "My actual project", note: "Keep this", order: 0 }],
    sessions: [], keys: [], order: {},
    settings: { confirmRemove: true, terminal: { fontSize: 14, cursorStyle: "block", scrollback: 5000 } },
  })
  await page.goto("/")
  await page.evaluate(value => localStorage.setItem("still.m2.store.v1", value), realStore)
  await page.goto(previewUrl)
  await expect(page.locator("[data-card]")).toHaveCount(8)
  await page.getByRole("button", { name: "Open Web · dev server on dev.preview.invalid", exact: true }).click()
  await expect(page.locator("#still-term-preview-terminal-web .xterm-helper-textarea")).toBeFocused()
  expect(await page.evaluate(() => localStorage.getItem("still.m2.store.v1"))).toBe(realStore)
  await page.reload()
  await expect(page.locator("[data-card]")).toHaveCount(8)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).projects.length, previewStoreKey)).toBe(3)
  expect(await page.evaluate(() => localStorage.getItem("still.m2.store.v1"))).toBe(realStore)
  await page.goto("/")
  await expect(page.locator("[data-card]")).toHaveCount(0)
  await expect(page.getByText("Workspace is empty", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("still.m2.store.v1"))).toBe(realStore)
})

test("native runtimes ignore the browser preview flag", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  })
  await page.goto(previewUrl)
  await expect(page.getByRole("button", { name: "New Session", exact: true }).first()).toBeVisible()
  await expect(page.locator("[data-card]")).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), previewStoreKey)).toBeNull()
})
