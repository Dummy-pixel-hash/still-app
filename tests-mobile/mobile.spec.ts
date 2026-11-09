import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: "reduce" }); await page.goto("/tests-mobile/fixture.html") })

test("phone launches a real thread library, not the desktop workspace", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Minimize", exact: true })).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Still workspace" })).toHaveCount(0)
  await expect(page.locator(".mobile-thread-row")).toHaveCount(3)
  await page.getByRole("button", { name: /Needs you/ }).first().click()
  await expect(page.locator(".mobile-thread-row")).toHaveCount(1)
  await expect(page.locator(".mobile-thread-row")).toContainText("Refine project navigation")
})

test("all root destinations use the floating mobile dock", async ({ page }) => {
  for (const name of ["Terminals", "Settings", "Agents"]) {
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click()
    await expect(page.getByRole("navigation", { name: "Main navigation" }).locator('[aria-current="page"]')).toHaveAttribute("aria-label", name)
  }
  await expect(page.locator(".mobile-navigation")).toHaveCSS("border-radius", "36px")
})

test("mobile creation and Enter preserve an unsent draft", async ({ page }) => {
  await page.getByRole("button", { name: "New task", exact: true }).click()
  await expect(page.locator(".agent-workspace--mobile")).toBeVisible()
  await expect(page.locator(".agent-sidebar")).toHaveCount(0)
  await page.getByRole("textbox", { name: "Message agent", exact: true }).fill("A task for the phone")
  await page.getByRole("textbox", { name: "Message agent", exact: true }).press("Enter")
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toHaveValue("A task for the phone\n")
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "New task", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toHaveValue("A task for the phone\n")
})

test("opening a thread reuses its actual persisted conversation", async ({ page }) => {
  await page.locator('.mobile-thread-row').filter({ hasText: "Fix reconnect after sleep" }).click()
  await expect(page.getByRole("heading", { name: "Fix reconnect after sleep", exact: true })).toBeVisible()
  await expect(page.locator(".agent-user-text")).toContainText("Keep the remote work intact.")
  await expect(page.locator(".mobile-navigation")).toBeHidden()
  const auth = page.getByRole("dialog", { name: "Authenticate Fixture server", exact: true })
  await expect(auth).toBeVisible()
  await auth.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
})

test("empty phone has no fabricated projects or conversations", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?empty")
  await expect(page.locator(".mobile-thread-row")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "A place for your next idea." })).toBeVisible()
  await page.getByRole("button", { name: /Add a project/ }).click()
  await expect(page.getByRole("dialog", { name: "Choose a project", exact: true })).toBeVisible()
})

test("compact mobile screens keep dock and primary actions inside the viewport", async ({ page }) => {
  for (const [width, height] of [[320, 568], [393, 852], [412, 915]]) {
    await page.setViewportSize({ width, height })
    await expect(page.locator(".mobile-navigation")).toBeInViewport()
    await expect(page.getByRole("button", { name: "New task", exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
