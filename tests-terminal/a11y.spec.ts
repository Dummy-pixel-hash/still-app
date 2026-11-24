import AxeBuilder from "@axe-core/playwright"
import { test, expect, type Page } from "@playwright/test"

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]

async function scan(page: Page, label: string, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(TAGS)
  if (include) builder = builder.include(include)
  const { violations } = await builder.analyze()
  const summary = violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 140)}`)
  expect(summary, `axe violations: ${label}`).toEqual([])
}

const open = (page: Page, name: string) => page.getByRole("button", { name: `Open Terminal ${name} on fixture.invalid`, exact: true })

test("workspace, populated and empty", async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
  await expect(open(page, "A")).toBeVisible()
  await scan(page, "populated workspace", "main")
  await page.goto("/tests-terminal/fixture.html?workspace&empty")
  await expect(page.getByText("Workspace is empty", { exact: true })).toBeVisible()
  await scan(page, "empty workspace", "main")
})

test("card menu and command palette", async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
  await page.getByRole("button", { name: "Actions for Terminal A" }).click()
  await expect(page.getByRole("menu")).toBeVisible()
  await scan(page, "card menu", "main")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+k")
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible()
  await scan(page, "palette", '[role="dialog"]')
})

test("every settings category", async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(dialog).toBeVisible()
  for (const name of ["General", "Terminal", "Themes", "Accessibility", "Keyboard shortcuts", "SSH keys", "Companion", "Updates"]) {
    await dialog.getByRole("tab", { name }).click()
    await expect(dialog.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true")
    await scan(page, `settings: ${name}`, '[role="dialog"]')
  }
})

test("overlay: error footer, host-key prompt and shortcut help", async ({ page }) => {
  await page.goto("/tests-terminal/fixture.html?workspace")
  await open(page, "A").click()
  await expect(page.locator("#still-term-terminal-a .xterm-helper-textarea")).toBeFocused()
  await page.evaluate(() => (window as any).harness.fail("terminal-a", "connection refused"))
  await expect(page.getByRole("alert").filter({ hasText: "connection refused" })).toBeVisible()
  await scan(page, "overlay error footer", '[data-overlay-root]')
  await page.evaluate(() => (window as any).harness.hostKeyPrompt("terminal-a"))
  await expect(page.getByRole("alertdialog")).toBeVisible()
  await scan(page, "overlay host-key prompt", '[data-overlay-root]')
  await page.getByRole("button", { name: "Reject" }).click()
  await page.keyboard.press("Control+Shift+/")
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible()
  await scan(page, "shortcut help", '[role="dialog"][aria-labelledby="shortcut-help-title"]')
})
