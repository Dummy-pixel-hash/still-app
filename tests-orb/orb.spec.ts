import { expect, test, type Page } from "@playwright/test"
import { mkdir } from "node:fs/promises"

const screenshots = "test-results/orb-review"
async function seed(page: Page, enabled = false) {
  await page.route("https://fonts.googleapis.com/**", route => route.fulfill({ body: "", contentType: "text/css" }))
  await page.addInitScript(({ enabled }) => {
    if (localStorage.getItem("orb-test-seeded")) return
    localStorage.setItem("orb-test-seeded", "1")
    localStorage.setItem("still.m2.store.v1", JSON.stringify({
      projects: [{ id: "fixture", name: "Orb test project", note: "Local UI simulation only", order: 0 }],
      sessions: [{ id: "s-orb-fixture", name: "Fixture session", host: "fixture.invalid", port: 22, username: "fixture", projectId: "fixture", workingDirectory: "~", authMethod: "ask", remember: false, tmuxSession: "fixture", createdAt: 1, updatedAt: 1 }],
      order: { fixture: ["s-orb-fixture"] }, keys: [],
      settings: { confirmRemove: true, terminal: { fontSize: 14, cursorStyle: "block", scrollback: 5000 }, imageInsertStyle: "path", orb: { enabled, size: 64, paused: true, speed: "normal" } },
    }))
  }, { enabled })
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  return page.getByRole("dialog", { name: "Settings", exact: true })
}
async function connectFixture(page: Page) {
  await page.evaluate(async () => {
    const { nativeBridge } = await import("/src/bridge/nativeBridge.ts")
    const oldConnect = nativeBridge.connect.bind(nativeBridge)
    const oldSubscribe = nativeBridge.subscribeToSession.bind(nativeBridge)
    const oldCommand = nativeBridge.orbCommand.bind(nativeBridge)
    const state = { connects: 0, commands: [] as string[], event: (_event: unknown) => {} }
    Object.assign(window, { orbTest: state })
    nativeBridge.connect = async args => { state.connects++; return oldConnect(args) }
    nativeBridge.subscribeToSession = (id, callback) => { state.event = callback; return oldSubscribe(id, callback) }
    nativeBridge.orbCommand = command => { state.commands.push(command.type); return oldCommand(command) }
    const { connectSession } = await import("/src/session/connections.ts")
    await connectSession({ localId: "s-orb-fixture", host: "fixture.invalid", port: 22, username: "fixture", authKind: "password", secret: "simulation-only", tmuxSession: "fixture" })
  })
}
const orb = (page: Page) => page.getByRole("button", { name: /^Still orb preview/ })
const canvasData = (page: Page) => page.getByTestId("dark").locator("canvas").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())

test.beforeAll(async () => { await mkdir(screenshots, { recursive: true }) })

test("approved glass renders with alpha, state colours, bounded size, motion and fallback", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto("/tests-orb/fixture.html")
  const host = page.getByTestId("dark").locator(".smoked-glass-host")
  await expect(host).toHaveAttribute("data-renderer", "webgl")
  await expect.poll(() => host.locator("canvas").evaluate(canvas => {
    const el = canvas as HTMLCanvasElement, gl = el.getContext("webgl")!, bytes = new Uint8Array(4)
    gl.readPixels(Math.floor(el.width / 2), Math.floor(el.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
    return bytes[3]
  })).toBeGreaterThan(240)
  expect(await host.locator("canvas").evaluate(canvas => {
    const gl = (canvas as HTMLCanvasElement).getContext("webgl")!, data = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return Array.from(data)
  })).toEqual([0, 0, 0, 0])
  for (const size of [48, 64, 96]) {
    await page.getByLabel("Visible size").selectOption(String(size))
    await expect(page.getByTestId("dark").locator(".smoked-glass")).toHaveCSS("width", `${size}px`)
    expect(await host.locator("canvas").evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeLessThanOrEqual(Math.ceil(size * 1.4 * 2))
  }
  const initial = await canvasData(page)
  await page.getByLabel("Visual state").selectOption("needs-input")
  await expect.poll(() => canvasData(page)).not.toBe(initial)
  await page.getByLabel("Visual state").selectOption("working")
  await page.getByLabel("Pause motion").uncheck()
  const active = await canvasData(page)
  await expect.poll(() => canvasData(page)).not.toBe(active)
  await page.getByLabel("Pause motion").check()
  await page.waitForTimeout(150)
  const paused = await canvasData(page)
  await page.waitForTimeout(350)
  expect(await canvasData(page)).toBe(paused)
  await page.screenshot({ path: `${screenshots}/material-desktop.png`, fullPage: true })
  await host.locator("canvas").evaluate(canvas => (canvas as HTMLCanvasElement).getContext("webgl")!.getExtension("WEBGL_lose_context")!.loseContext())
  await expect(host).toHaveAttribute("data-renderer", "2d")
  await expect(page.locator("canvas")).toHaveCount(8)
  await expect.poll(() => host.locator("canvas").evaluate(canvas => {
    const el = canvas as HTMLCanvasElement
    return el.getContext("2d")!.getImageData(Math.floor(el.width / 2), Math.floor(el.height / 2), 1, 1).data[3]
  })).toBeGreaterThan(240)
  await page.getByLabel("Force Canvas2D").check()
  await expect(page.getByTestId("light").locator(".smoked-glass-host")).toHaveAttribute("data-renderer", "2d")
  await page.screenshot({ path: `${screenshots}/material-fallback.png`, fullPage: true })
  expect(errors).toEqual([])
})

test("reduced motion freezes visible frames even when animation is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-orb/fixture.html")
  await page.getByLabel("Pause motion").uncheck()
  await expect(page.getByTestId("dark").locator(".smoked-glass-host")).toHaveAttribute("data-renderer", "webgl")
  await page.waitForTimeout(200)
  const before = await canvasData(page)
  await page.waitForTimeout(400)
  expect(await canvasData(page)).toBe(before)
})

test("idle and unknown materials keep a slow ambient drift when motion is on", async ({ page }) => {
  await page.goto("/tests-orb/fixture.html")
  await expect(page.getByTestId("dark").locator(".smoked-glass-host")).toHaveAttribute("data-renderer", "webgl")
  await page.getByLabel("Pause motion").uncheck()
  for (const state of ["idle", "unknown"]) {
    await page.getByLabel("Visual state").selectOption(state)
    const before = await canvasData(page)
    await expect.poll(() => canvasData(page), { timeout: 5000 }).not.toBe(before)
  }
})

test("browser orb route drifts while it waits for Still", async ({ page }) => {
  await page.goto("/?orb=1&state=idle")
  await expect(page.getByRole("button", { name: /Waiting for Still/ })).toBeVisible()
  const frame = () => page.locator(".smoked-glass-host canvas").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())
  const before = await frame()
  await expect.poll(frame, { timeout: 5000 }).not.toBe(before)
})

test("settings enable a browser-only preview; menu preferences, drag, nudge and reset work", async ({ page }) => {
  await seed(page)
  await page.goto("/")
  await expect(orb(page)).toHaveCount(0)
  const dialog = await settings(page)
  await dialog.getByLabel("Enable orb companion").check()
  await expect(orb(page)).toBeVisible()
  await dialog.getByLabel("Orb size").selectOption("96")
  await expect(orb(page)).toHaveCSS("width", "96px")
  await dialog.getByLabel("Animation speed").selectOption("fast")
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("still.m2.store.v1")!).settings.orb.speed)).toBe("fast")
  await dialog.getByRole("button", { name: "Reset position", exact: true }).click()
  await expect(dialog).toContainText("Position reset.")
  await page.screenshot({ path: `${screenshots}/settings-desktop.png` })
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await expect(orb(page)).toHaveAccessibleName(/No active connections/)
  const start = await orb(page).boundingBox()
  await page.mouse.move(start!.x + 48, start!.y + 48)
  await page.mouse.down()
  await page.mouse.move(start!.x - 150, start!.y - 50, { steps: 8 })
  await page.mouse.up()
  const moved = await orb(page).boundingBox()
  expect(moved!.x).toBeLessThan(start!.x - 100)
  await orb(page).focus(); await page.keyboard.press("ArrowLeft")
  await expect.poll(async () => (await orb(page).boundingBox())!.x).toBe(moved!.x - 8)
  await orb(page).click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Orb controls" })
  await expect(menu).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu).toHaveCount(0)
  await expect(orb(page)).toBeFocused()
  await page.keyboard.press("Shift+F10")
  await menu.getByRole("menuitem", { name: "Reset position", exact: true }).click()
  await expect.poll(async () => (await orb(page).boundingBox())!.x).toBe(start!.x)
  await orb(page).click({ button: "right" })
  await menu.getByRole("menuitem", { name: "Resume motion", exact: true }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("still.m2.store.v1")!).settings.orb.paused)).toBe(false)
  await orb(page).click({ button: "right" })
  await page.screenshot({ path: `${screenshots}/preview-menu.png` })
  await menu.getByRole("menuitem", { name: "Hide orb", exact: true }).click()
  await expect(orb(page)).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("still.m2.store.v1")!).settings.orb.enabled)).toBe(false)
  await page.reload()
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible()
  await expect(orb(page)).toHaveCount(0)
})

test("observed output is not an agent verdict; actual host-key events change attention", async ({ page }) => {
  await seed(page, true)
  await page.goto("/")
  await expect(orb(page)).toBeVisible()
  await connectFixture(page)
  await expect(orb(page)).toHaveAccessibleName(/Output active/)
  await page.evaluate(async () => {
    const { writeSession } = await import("/src/session/connections.ts")
    await writeSession("s-orb-fixture", "Done! Waiting for approval? This is arbitrary terminal output.")
  })
  await expect(orb(page)).toHaveAccessibleName(/Output active/)
  await expect(orb(page)).toHaveAccessibleName(/agent status unknown/, { timeout: 12000 })
  await page.evaluate(() => (window as any).orbTest.event({ type: "hostKeyPrompt", prompt: { host: "fixture.invalid", port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:fixture", opensshKey: "fixture", changed: false } }))
  await expect(orb(page)).toHaveAccessibleName(/Review host key/)
  await page.evaluate(() => (window as any).orbTest.event({ type: "hostKeyPrompt", prompt: { host: "fixture.invalid", port: 22, keyType: "ssh-ed25519", fingerprint: "SHA256:fixture", opensshKey: "fixture", changed: true } }))
  await expect(orb(page)).toHaveAccessibleName(/Host key changed/)
  await orb(page).click({ button: "right" })
  await expect(page.getByRole("menu", { name: "Orb controls" })).toContainText("Host key changed")
  await page.screenshot({ path: `${screenshots}/preview-attention.png` })
  await page.evaluate(async () => {
    const { disconnectSession } = await import("/src/session/connections.ts")
    await disconnectSession("s-orb-fixture")
  })
  await page.keyboard.press("Escape")
  await expect(orb(page)).toHaveAccessibleName(/No active connections/)
})

test("drag does not activate; session activation survives filtering and never auto-reconnects", async ({ page }) => {
  await seed(page, true)
  await page.goto("/")
  await expect(orb(page)).toBeVisible()
  await connectFixture(page)
  await expect(orb(page)).toHaveAccessibleName(/Output active/)
  const start = await orb(page).boundingBox()
  await page.mouse.move(start!.x + 32, start!.y + 32)
  await page.mouse.down(); await page.mouse.move(start!.x - 80, start!.y - 90, { steps: 8 }); await page.mouse.up()
  expect(await page.evaluate(() => (window as any).orbTest.commands)).not.toContain("open")
  await page.getByRole("textbox", { name: "Search sessions" }).fill("does-not-match")
  await expect(page.locator('[data-card="s-orb-fixture"]')).toHaveCount(0)
  await orb(page).click()
  // Disconnect during the existing card-origin morph: orb activation must not reconnect.
  await page.evaluate(async () => {
    const { disconnectSession } = await import("/src/session/connections.ts")
    await disconnectSession("s-orb-fixture")
  })
  await expect(page.locator('[data-overlay-root="solo"]')).toHaveAttribute("aria-hidden", "false")
  await page.waitForTimeout(1100)
  expect(await page.evaluate(() => (window as any).orbTest.connects)).toBe(1)
  await expect(page.getByRole("dialog", { name: /Sign in|Authenticate/ })).toHaveCount(0)
})

test("isolated native entry stays transparent and does not load Workspace or xterm", async ({ page }) => {
  const requests: string[] = []
  page.on("request", request => requests.push(request.url()))
  await page.goto("/?orb=1&state=done")
  await expect(page.getByRole("main", { name: "Still companion" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Waiting for Still/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => [document.documentElement, document.body, document.getElementById("root")!].map(el => getComputedStyle(el).backgroundColor))).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"])
  expect(requests.some(url => /screens\/Workspace|session\/connections|@xterm/.test(url))).toBe(false)
  expect(await page.locator("canvas").count()).toBe(1)
  const button = page.getByRole("button", { name: /Waiting for Still/ })
  await button.focus()
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await expect(button).toHaveCSS("outline-style", "none")
})

test("settings and preview menu fit a 390px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seed(page)
  await page.goto("/")
  const dialog = await settings(page)
  await dialog.getByLabel("Enable orb companion").check()
  await dialog.getByLabel("Orb size").selectOption("96")
  await page.screenshot({ path: `${screenshots}/settings-mobile.png` })
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await orb(page).click({ button: "right" })
  const bounds = await page.getByRole("menu", { name: "Orb controls" }).boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
  await page.screenshot({ path: `${screenshots}/preview-mobile.png` })
})
