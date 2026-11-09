import { test, expect } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/live.js?*", route => route.abort())
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/tests-agents/fixture.html?demo&layout=split")
  await page.locator(".agent-recent").first().click()
})

test("accepted project hierarchy has one accessible navigation tree and clear selection", async ({ page }) => {
  const sidebar = page.locator(".agent-sidebar")
  const panel = sidebar.locator("#agent-project-navigation")
  await expect(panel).toHaveCount(1)
  await expect(sidebar.locator(".agent-sidebar-search")).toHaveCount(1)
  await expect(sidebar.locator(".agent-thread-list")).toHaveCount(1)
  await expect(sidebar.locator(".agent-thread.is-selected")).toContainText("Refine project navigation")
  await expect(sidebar.locator(".agent-thread.is-selected")).toHaveCSS("background-color", "rgba(255, 255, 255, 0.055)")
  await expect(sidebar.locator(".agent-thread.is-selected .agent-thread-title")).toHaveCSS("font-weight", "600")
  await expect(sidebar.locator(".agent-folder-threads").first()).toHaveCSS("border-left-width", "1px")
  const toggle = page.getByRole("button", { name: "Collapse project sidebar", exact: false })
  await expect(toggle).toHaveAttribute("aria-controls", "agent-project-navigation")
  await expect(page.locator("[data-impeccable-variants], [data-impeccable-carbonize], [data-impeccable-variant], style[data-impeccable-css]")).toHaveCount(0)
})

test("search, project disclosure and sidebar focus still work after the polish", async ({ page }) => {
  const search = page.getByRole("textbox", { name: "Search conversations", exact: true })
  await search.fill("keyboard")
  await expect(page.locator(".agent-thread-open")).toHaveCount(1)
  await expect(page.locator(".agent-thread-title")).toHaveText("Add keyboard shortcuts")
  await search.fill("")
  const projectToggle = page.getByRole("button", { name: "Toggle still conversations", exact: true })
  await projectToggle.click()
  await expect(projectToggle).toHaveAttribute("aria-expanded", "false")
  await projectToggle.click()
  await expect(projectToggle).toHaveAttribute("aria-expanded", "true")
  await page.getByRole("button", { name: "Collapse project sidebar", exact: false }).click()
  await expect(page.getByRole("button", { name: "Expand project sidebar", exact: false })).toBeFocused()
  await page.getByRole("button", { name: "Expand project sidebar", exact: false }).click()
  await expect(search).toBeVisible()
})

test("hierarchy spacing and conversation rows fit the panel at desktop and compact widths", async ({ page }) => {
  for (const [width, height] of [[1440, 900], [1024, 768], [800, 900], [620, 700], [390, 844]]) {
    await page.setViewportSize({ width, height })
    const panel = page.locator("#agent-project-navigation")
    if (width <= 800) {
      if (await page.getByRole("button", { name: "Show projects", exact: true }).isVisible()) {
        await page.getByRole("button", { name: "Show projects", exact: true }).click()
      }
    }
    const bounds = await panel.evaluate(el => {
      const outer = el.getBoundingClientRect()
      const rows = [...el.querySelectorAll<HTMLElement>(".agent-folder-heading, .agent-thread")].filter(row => row.getClientRects().length).map(row => {
        const rect = row.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      })
      return { left: outer.left, right: outer.right, rows }
    })
    for (const row of bounds.rows) {
      expect(row.left).toBeGreaterThanOrEqual(bounds.left - 1)
      expect(row.right).toBeLessThanOrEqual(bounds.right + 1)
    }
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
})
