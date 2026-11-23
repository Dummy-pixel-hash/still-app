import { test, expect } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/live.js?*", route => route.abort())
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/tests-agents/fixture.html?demo&mobile=1")
  await page.getByRole("button", { name: /Refine project navigation/ }).click()
  await expect(page.locator(".agent-workspace--mobile")).toBeVisible()
})

test("the native mobile detail uses the compact mock header and readable conversation hierarchy", async ({ page }) => {
  const header = page.locator(".mobile-agent-header")
  await expect(header).toBeVisible()
  await expect(header.getByRole("heading", { name: "Refine project navigation" })).toBeVisible()
  const back = header.getByRole("button", { name: "Back to threads", exact: true })
  const search = header.getByRole("button", { name: "Find a message", exact: true })
  const changes = header.getByRole("button", { name: "Review changes", exact: true })
  for (const button of [back, search, changes]) {
    const box = await button.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  }
  await expect(header).toHaveCSS("border-radius", "12px")

  const userMessage = page.locator(".agent-message-user").first()
  await expect(userMessage).toHaveCSS("border-radius", "13px")
  await expect(userMessage.locator(".agent-user-text")).toHaveCSS("font-size", "16px")
  const answer = page.locator(".agent-message-assistant .agent-prose").first()
  await expect(answer).toHaveCSS("font-size", "16px")
  await expect(answer.locator("h3")).toHaveCSS("font-size", "20px")
  await expect(page.locator(".agent-activity-summary").first()).toBeVisible()
  await expect(page.locator(".agent-composer.is-collapsed")).toBeVisible()
  await expect(page.locator(".mobile-navigation")).toBeHidden()
})

test("mobile controls and collapsed summaries stay in-bounds at narrow phone widths", async ({ page }) => {
  for (const [width, height] of [[390, 844], [360, 800], [320, 640]]) {
    await page.setViewportSize({ width, height })
    const header = page.locator(".mobile-agent-header")
    const geometry = await header.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        children: [...element.children].map(child => {
          const rect = child.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        }),
      }
    })
    for (const child of geometry.children) {
      expect(child.left).toBeGreaterThanOrEqual(geometry.left - 1)
      expect(child.right).toBeLessThanOrEqual(geometry.right + 1)
    }
    await expect(page.locator(".mobile-agent-header .mobile-icon-button")).toHaveCount(3)
    await expect(page.locator(".mobile-agent-header").getByRole("button", { name: "Back to threads" })).toBeInViewport()
    expect(await page.locator(".mobile-app").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  }
})

test("the mobile back action returns to the persistent thread library", async ({ page }) => {
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await expect(page.locator(".agent-workspace--mobile")).toHaveCount(0)
  await expect(page.locator(".mobile-thread-row").first()).toBeVisible()
  await expect(page.locator(".mobile-navigation")).toBeVisible()
})
