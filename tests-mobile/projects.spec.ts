import { expect, test } from "@playwright/test"
import { mobileLibraryPreferences, mobileProjectLibrary, threadActivity } from "../src/mobile/projectThreads"
import { projectKey } from "../src/agents/projectIdentity"
import { visibleThreads } from "../src/mobile/threads"
import type { AgentThreadRow } from "../src/session/agentThreads"

const host = JSON.stringify(["example.invalid", 22, "fixture"])
const otherHost = JSON.stringify(["example.invalid", 22, "release"])
const alpha = projectKey({ host, folder: "/srv/alpha" })
const still = projectKey({ host, folder: "/srv/still" })
const otherStill = projectKey({ host: otherHost, folder: "/srv/still" })
const empty = projectKey({ host, folder: "/srv/empty" })
const fixtureStorageKey = "still.mobile.projects-fixture.preferences"

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.route("**/live.js?*", route => route.abort())
})

test("project identity and ordering are deterministic without changing conversation metadata", () => {
  const row = (id: string, folder: string, activityAt: number, pinned = false) => ({
    executionId: id, transcript: [], meta: { id, hostKey: host, folder, activityAt, pinned, title: id, draft: "" },
  } as unknown as AgentThreadRow)
  const rows = [row("newer", "/b", 20), row("pinned", "/b", 10, true), row("oldest", "/a", 1)]
  const before = structuredClone(rows)
  const projects = [{ host, folder: "/b", name: "Project 10" }, { host, folder: "/a", name: "Project 2" }, { host: otherHost, folder: "/b", name: "Project 10" }]
  const recent = mobileProjectLibrary(rows, projects, [], { project: "all", sort: "recent", attentionOnly: false, query: "" })
  expect(recent.groups.map(group => group.project.folder)).toEqual(["/b", "/a"])
  expect(recent.groups[0].rows.map(row => row.meta.id)).toEqual(["pinned", "newer"])
  expect(recent.projects).toHaveLength(3)
  const named = mobileProjectLibrary(rows, projects, [], { project: "all", sort: "name", attentionOnly: false, query: "" })
  expect(named.projects.map(group => group.label)).toEqual(["Project 2", "Project 10", "Project 10"])
  expect(rows).toEqual(before)
  expect(projectKey({ host, folder: "/b" })).not.toBe(projectKey({ host: otherHost, folder: "/b" }))
})

test("saved view inputs are bounded and invalid dates cannot break the list", () => {
  expect(mobileLibraryPreferences(null)).toEqual({ project: "all", sort: "recent", collapsed: [] })
  expect(mobileLibraryPreferences({ project: [], sort: "manual", collapsed: [false, alpha, alpha, "x".repeat(9000)] }))
    .toEqual({ project: "all", sort: "recent", collapsed: [alpha] })
  expect(mobileLibraryPreferences({ collapsed: Array.from({ length: 600 }, (_, i) => `${i}`) }).collapsed).toHaveLength(512)
  for (const activityAt of [NaN, Infinity, -1, 8_640_000_000_000_001]) {
    expect(threadActivity({ meta: { activityAt } } as AgentThreadRow)).toBe(0)
  }
  const draft = { meta: { archivedAt: 1, sharedDeleted: true, draft: "Unsaved local work" }, transcript: [] } as unknown as AgentThreadRow
  expect(visibleThreads([draft])).toEqual([draft])
})

test("projects group by account and folder; sort and pinned rows stay predictable", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?projects=1")
  const groups = page.locator(".mobile-project-group")
  await expect(groups).toHaveCount(3)
  await expect.poll(() => groups.evaluateAll(elements => elements.map(element => element.getAttribute("data-project-key")))).toEqual([still, alpha, otherStill])
  await expect(page.locator(".mobile-thread-row")).toHaveCount(4)
  await expect(groups.nth(1).locator(".mobile-thread-copy > strong")).toHaveText(["Add keyboard shortcuts", "Fix reconnect after sleep"])
  await expect(groups.nth(1).getByRole("button", { name: /Add keyboard shortcuts.*Pinned/ })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Filter threads by project" }).locator("option")).toHaveCount(5)
  await page.getByRole("combobox", { name: "Sort projects", exact: true }).selectOption("name")
  await expect.poll(() => groups.evaluateAll(elements => elements.map(element => element.getAttribute("data-project-key")))).toEqual([alpha, still, otherStill])
  await expect(groups.nth(2)).toContainText("release@example.invalid")
  await page.getByRole("combobox", { name: "Filter threads by project" }).selectOption(otherStill)
  await expect(page.locator(".mobile-thread-row")).toHaveCount(1)
  await expect(page.locator(".mobile-thread-row")).toContainText("Review release checklist")
  await expect(page.getByRole("button", { name: "Sync conversations · Release server · release@example.invalid", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sync conversations · Fixture server · fixture@example.invalid", exact: true })).toHaveCount(0)
})

test("collapsed groups never hide search results or requests and preferences survive reload", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?projects=1")
  const group = page.getByRole("region", { name: "Still mobile · fixture@example.invalid · /srv/still", exact: true })
  await group.getByRole("button", { name: /^Collapse/ }).click()
  await expect(group.getByRole("button", { name: /^Expand/ })).toHaveAttribute("aria-expanded", "false")
  await expect(group.locator(".mobile-thread-row")).toBeHidden()
  await page.getByRole("button", { name: /^Needs you/ }).click()
  await expect(group.locator(".mobile-thread-row")).toBeVisible()
  await page.getByRole("button", { name: "All threads", exact: true }).click()
  await expect(group.locator(".mobile-thread-row")).toBeHidden()
  await page.getByRole("button", { name: "Search threads", exact: true }).click()
  await page.getByRole("searchbox", { name: "Find a thread", exact: true }).fill("refine")
  await expect(group.locator(".mobile-thread-row")).toBeVisible()
  await page.getByRole("searchbox", { name: "Find a thread", exact: true }).fill("FIXTURE@EXAMPLE.INVALID")
  await expect(page.locator(".mobile-thread-row:visible")).toHaveCount(3)
  await page.getByRole("button", { name: "Search threads", exact: true }).click()
  await expect(page.getByRole("searchbox", { name: "Find a thread", exact: true })).toHaveCount(0)
  await expect(page.locator(".mobile-thread-row")).toHaveCount(4)
  await page.getByRole("combobox", { name: "Sort projects", exact: true }).selectOption("name")
  await page.getByRole("combobox", { name: "Filter threads by project" }).selectOption(alpha)
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) || "null"), fixtureStorageKey))
    .toEqual({ project: alpha, sort: "name", collapsed: [still] })
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Filter threads by project" })).toHaveValue(alpha)
  await expect(page.getByRole("combobox", { name: "Sort projects", exact: true })).toHaveValue("name")
  await expect(page.locator(".mobile-thread-row:visible")).toHaveCount(2)
  await page.getByRole("combobox", { name: "Filter threads by project" }).selectOption("all")
  await expect(page.locator(".mobile-project-group").first().getByRole("button", { name: /^Collapse/ })).toBeVisible()
  await expect(page.locator(".mobile-project-group").nth(1).getByRole("button", { name: /^Expand/ })).toBeVisible()
})

test("empty and attention filters explain their scope, and new tasks inherit the selected project", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?projects=1")
  const picker = page.getByRole("combobox", { name: "Filter threads by project" })
  await picker.selectOption(alpha)
  await page.getByRole("button", { name: /^Needs you/ }).click()
  await expect(page.getByRole("heading", { name: "No requests in this project." })).toBeVisible()
  await expect(page.getByText("Other projects have conversations that need you.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Show all projects", exact: true }).click()
  await expect(page.locator(".mobile-thread-row")).toHaveCount(1)
  await page.getByRole("button", { name: "All threads", exact: true }).click()
  await picker.selectOption(empty)
  await expect(page.getByRole("heading", { name: "No threads in this project yet." })).toBeVisible()
  await expect(page.getByRole("button", { name: "New task", exact: true })).toBeEnabled()
  await picker.selectOption(alpha)
  await page.getByRole("button", { name: "New task", exact: true }).click()
  await expect(page.locator(".mobile-agent-heading")).toContainText("Alpha lab")
  await expect(page.getByRole("dialog", { name: "Choose a project", exact: true })).toHaveCount(0)
  const auth = page.getByRole("dialog", { name: "Authenticate Fixture server", exact: true })
  if (await auth.isVisible()) await auth.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("textbox", { name: "Message agent", exact: true }).fill("Keep this project draft unsent")
  await page.getByRole("button", { name: "Back to threads", exact: true }).click()
  await expect(picker).toHaveValue(alpha)
  await page.getByRole("button", { name: "New task", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message agent", exact: true })).toHaveValue("Keep this project draft unsent")
})

test("a stale saved project selection safely returns to all projects", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?projects=1")
  await page.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ project: "removed-project", sort: "name", collapsed: [] })), { key: fixtureStorageKey })
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Filter threads by project" })).toHaveValue("all")
  await expect(page.locator(".mobile-thread-row")).toHaveCount(4)
  await expect(page.getByRole("combobox", { name: "Sort projects", exact: true })).toHaveValue("name")
})

test("multi-server sync stays compact and system Back dismisses its account choices", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?projects=1&duplicateServerNames=1")
  const chooser = page.getByRole("button", { name: "Choose a server to sync conversations", exact: true })
  await expect(chooser).toHaveAttribute("aria-expanded", "false")
  await chooser.click()
  await expect(chooser).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByRole("button", { name: "Sync conversations · Fixture server · fixture@example.invalid", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sync conversations · Fixture server · release@example.invalid", exact: true })).toBeVisible()
  await expect(page.locator(".mobile-sync-source-label small")).toHaveText(["fixture@example.invalid", "release@example.invalid"])
  await page.evaluate(() => window.__stillMobileBack?.())
  await expect(chooser).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByRole("heading", { name: "Threads", exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Filter threads by project" }).selectOption(still)
  await expect(chooser).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Sync conversations · Fixture server · fixture@example.invalid", exact: true })).toBeVisible()
})

test("project controls remain accessible at narrow and expanded phone sizes", async ({ page }) => {
  await page.goto("/tests-mobile/fixture.html?projects=1")
  for (const width of [320, 360, 393, 600]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 852 })
    const controls = page.locator(".mobile-library-controls select")
    for (const control of await controls.all()) {
      const box = await control.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThanOrEqual(48)
      expect(box!.height).toBeGreaterThanOrEqual(48)
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      await control.focus()
      await expect(control.locator("..")).toHaveCSS("outline-style", "solid")
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    await expect(page.getByRole("button", { name: "New task", exact: true })).toBeVisible()
    await expect(page.locator(".mobile-thread-copy > strong").first()).toBeInViewport({ ratio: 1 })
    await expect(page.locator(".mobile-project-folder").first()).toHaveText("/srv/still")
    await expect(page.locator(".mobile-project-folder").first()).toBeInViewport({ ratio: 1 })
  }
})
