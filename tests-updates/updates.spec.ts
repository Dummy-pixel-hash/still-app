import { expect, test } from "@playwright/test"

const fixture = "/tests-updates/fixture.html"
const calls = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { updateTest: { calls: string[] } }).updateTest.calls)

test("Windows install remains unavailable until signature verification resolves, then asks for consent", async ({ page }) => {
  await page.goto(fixture)
  await page.getByRole("button", { name: "Check for updates", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Verifying the update signature…")
  await expect(page.getByRole("button", { name: "Install and restart", exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as unknown as { updateTest: { release: () => void } }).updateTest.release())
  await page.getByRole("button", { name: "Install and restart", exact: true }).click()
  await expect(page.getByText("Save unfinished work first.", { exact: false })).toBeVisible()
  expect((await calls(page)).some(value => value.startsWith("plugin:updater|install"))).toBe(false)
  await page.screenshot({ path: "test-results/updates-windows-confirm.png" })
  await page.getByRole("button", { name: "Install now", exact: true }).click()
  await expect.poll(async () => (await calls(page)).filter(value => value.startsWith("plugin:updater|install")).length).toBe(1)
});

test("bad signatures never enable installation and can be retried", async ({ page }) => {
  await page.goto(fixture)
  await page.getByRole("button", { name: "Check for updates", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Verifying the update signature…")
  await page.evaluate(() => (window as unknown as { updateTest: { rejectDownload: () => void } }).updateTest.rejectDownload())
  await expect(page.getByRole("status")).toContainText("Signature verification failed")
  await expect(page.getByRole("button", { name: "Install and restart", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Retry update check" }).click()
  await expect(page.getByRole("status")).toHaveText("Verifying the update signature…")
});

test("failed Windows installation rechecks and downloads instead of reusing a consumed byte resource", async ({ page }) => {
  await page.goto(`${fixture}?scenario=install-failure`)
  await page.getByRole("button", { name: "Check for updates", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Verifying the update signature…")
  await page.evaluate(() => (window as unknown as { updateTest: { release: () => void } }).updateTest.release())
  await page.getByRole("button", { name: "Install and restart", exact: true }).click()
  await page.getByRole("button", { name: "Install now", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("The installer could not be started")
  await expect(page.getByRole("button", { name: "Install and restart", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Retry update check" }).click()
  await expect(page.getByRole("status")).toHaveText("Verifying the update signature…")
  expect((await calls(page)).filter(value => value.startsWith("plugin:updater|download")).length).toBe(2)
});

test("offline checks provide a working retry and MSI installations are not switched silently", async ({ page }) => {
  await page.goto(`${fixture}?scenario=offline`)
  await page.getByRole("button", { name: "Check for updates", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Offline")
  await page.getByRole("button", { name: "Retry update check" }).click()
  await expect(page.getByRole("status")).toHaveText("Verifying the update signature…")
  await page.goto(`${fixture}?scenario=msi`)
  await page.getByRole("button", { name: "Check for updates", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("one-time manual installation")
  expect((await calls(page)).some(value => value.startsWith("plugin:updater|download"))).toBe(false)
});

test("Android supports network preferences and explicit installation permission handoff", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    userAgent: "Mozilla/5.0 (Linux; Android 14; Phone) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
  })
  const page = await context.newPage()
  await page.goto(`${fixture}?scenario=android`)
  await expect(page.getByRole("checkbox")).not.toBeChecked()
  await page.getByRole("checkbox").check()
  await expect(page.getByRole("checkbox")).toBeChecked()
  await page.getByRole("button", { name: "Install update", exact: true }).click()
  await page.screenshot({ path: "test-results/updates-android-confirm.png" })
  await page.getByRole("button", { name: "Install now", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Allow updates from Still")
  expect((await calls(page)).filter(value => value === "still_android_update:install").length).toBe(1)
  await expect(page.getByRole("button", { name: "Install update", exact: true })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  await context.close()
});

test("browser preview has no dead native-update controls", async ({ page }) => {
  await page.goto(`${fixture}?scenario=browser`)
  await expect(page.getByRole("heading", { name: "Still settings" })).toBeVisible()
  await expect(page.getByRole("button")).toHaveCount(0)
});
