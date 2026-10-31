import { test, expect, type Page } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/__impeccable/**", route => route.abort())
  await page.route("**/live.js?*", route => route.abort())
  await page.goto("/tests-agents/fixture.html")
})

async function addFolder(page: Page, path: string) {
  if (!await page.getByRole("button", { name: "Add project folder", exact: true }).isVisible()) await page.getByRole("button", { name: "Toggle projects" }).click()
  await page.getByRole("button", { name: "Add project folder", exact: true }).click()
  await page.getByLabel("Remote project folder").fill(path)
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
}

async function connect(page: Page, message = "Check this repository") {
  if (!await page.locator(".agent-context-line").isVisible()) await addFolder(page, "/srv/still")
  await page.locator('[data-config-id="provider"] > button').click()
  await page.getByRole("option", { name: /^OpenCode\b/ }).click()
  await page.getByLabel("Message agent").fill(message)
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.locator(".agent-message-assistant").last()).toContainText("First second third.")
  await page.evaluate(() => (window as any).agentFixture.finish())
}

async function openRepository(page: Page) {
  await page.getByRole("button", { name: "Review changes", exact: true }).click()
  const panel = page.getByRole("complementary", { name: "Repository changes" })
  await expect(panel).toBeVisible()
  return panel
}

test("Changes opens Repository by default, scopes each diff request, and keeps status totals separate", async ({ page }) => {
  await connect(page)
  const panel = await openRepository(page)
  await expect(page.getByRole("tab", { name: "Repository" })).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(1)
  await expect(panel.locator(".agent-repository-server")).toContainText("dev.example.test")
  await expect(panel.locator(".agent-repository-identity code")).toHaveText("/srv/still")
  await expect(panel.locator(".agent-repository-file-path").first()).toHaveText("src/current.ts")
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitDiffCalls.length)).toBe(1)
  await expect(panel.locator(".agent-repository-diff .agent-code-language span").first()).toHaveText("src/current.ts")

  const initialRequest = await page.evaluate(() => (window as any).agentFixture.gitDiffCalls[0])
  expect(initialRequest).toMatchObject({ cwd: "/srv/still", snapshotId: "git-fixture-1", entryId: "git-fixture-source", view: "combined" })
  expect(Object.keys(initialRequest).sort()).toEqual(["cwd", "entryId", "nativeSessionId", "snapshotId", "view"])

  await panel.getByRole("tab", { name: "Staged", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitDiffCalls.length)).toBe(2)
  expect(await page.evaluate(() => (window as any).agentFixture.gitDiffCalls.at(-1).view)).toBe("staged")
  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.gitEntries = [...h.gitEntries, { id:"git-fixture-manual",path:"server/manual-edit.ts",indexStatus:".",worktreeStatus:"?",kind:"untracked",additions:null,deletions:null,binary:null }]
  })
  await panel.getByRole("button", { name: "Refresh" }).click()
  await expect(panel.getByRole("button", { name: /server\/manual-edit\.ts/ })).toBeVisible()
  expect(await page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(2)
  const repositoryTab = panel.getByRole("tab", { name: "Repository" })
  await repositoryTab.focus()
  await page.keyboard.press("ArrowRight")
  const conversationPanel = page.getByRole("complementary", { name: "Conversation changes" })
  await expect(conversationPanel.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("ArrowLeft")
  const restoredRepositoryPanel = page.getByRole("complementary", { name: "Repository changes" })
  await expect(restoredRepositoryPanel.getByRole("tab", { name: "Repository" })).toHaveAttribute("aria-selected", "true")
  await restoredRepositoryPanel.getByRole("tab", { name: "Conversation" }).click()
  await expect(page.getByRole("complementary", { name: "Conversation changes" })).toBeVisible()
  await expect(page.locator(".agent-review-context")).toContainText("From this conversation")
  expect(await page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(3)
})

test("the transcript summary opens historical Conversation changes without reading Git", async ({ page }) => {
  await connect(page)
  await page.evaluate(() => (window as any).agentFixture.emit((window as any).agentFixture.current, {
    type: "toolStart", toolCallId: "reported-edit", status: "completed",
    content: [{ type: "diff", path: "src/reported.ts", oldText: "before\n", newText: "after\n" }],
  }))
  await page.getByRole("button", { name: "Review 1 changed file", exact: true }).click()
  const panel = page.getByRole("complementary", { name: "Conversation changes" })
  await expect(panel.getByRole("tab", { name: "Conversation" })).toHaveAttribute("aria-selected", "true")
  await expect(panel.locator(".agent-code-language span").first()).toHaveText("src/reported.ts")
  expect(await page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(0)
})

test("refresh failures retain the last repository snapshot and truncated empty results never claim clean", async ({ page }) => {
  await connect(page)
  const panel = await openRepository(page)
  await expect(panel.locator(".agent-repository-file-path").first()).toHaveText("src/current.ts")

  await page.evaluate(() => { (window as any).agentFixture.failGitStatus = true })
  await panel.getByRole("button", { name: "Refresh" }).click()
  await expect(panel.getByRole("alert")).toContainText("Git status is unavailable")
  await expect(panel.locator(".agent-repository-file-path").first()).toHaveText("src/current.ts")

  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.failGitStatus = false
    h.gitStatusState = "notRepository"
  })
  await panel.getByRole("button", { name: "Refresh" }).click()
  await expect(panel.getByRole("heading", { name: "This folder is not inside a Git working tree." })).toBeVisible()
  await page.getByRole("tab", { name: "Conversation" }).click()
  const conversationPanel = page.getByRole("complementary", { name: "Conversation changes" })
  await expect(conversationPanel.getByRole("heading", { name: "No reported changes yet" })).toBeVisible()

  await page.evaluate(() => {
    const h = (window as any).agentFixture
    h.gitStatusState = "ready"
    h.gitEntries = []
    h.gitTruncated = true
  })
  await conversationPanel.getByRole("tab", { name: "Repository" }).click()
  const repositoryPanel = page.getByRole("complementary", { name: "Repository changes" })
  await expect(repositoryPanel.getByText(/file list reached its safety limit/i)).toBeVisible()
  await expect(repositoryPanel.getByRole("heading", { name: "No uncommitted changes." })).toHaveCount(0)
})

test("repository status is read once per opening and once after a visible turn boundary", async ({ page }) => {
  await connect(page)
  await page.evaluate(() => { (window as any).agentFixture.deferGitStatus = true })
  const panel = await openRepository(page)
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(1)
  await page.evaluate(() => (window as any).agentFixture.emit((window as any).agentFixture.current, { type: "userMessage", text: "Make one more change" }))
  await expect.poll(() => page.evaluate(() => (window as any).agentThreadRows.find((row: any) => row.executionId === (window as any).agentFixture.current)?.turnActive)).toBe(true)
  await page.evaluate(() => (window as any).agentFixture.emit((window as any).agentFixture.current, { type: "assistantChunk", text: "Still working…" }))
  await page.evaluate(() => (window as any).agentFixture.finish())
  await expect.poll(() => page.evaluate(() => (window as any).agentThreadRows.find((row: any) => row.executionId === (window as any).agentFixture.current)?.turnActive)).toBe(false)
  expect(await page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(1, "the open read is reused while it is in flight")
  await page.evaluate(() => (window as any).agentFixture.releaseGitStatus(0, 1))
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(2)
  await page.evaluate(() => (window as any).agentFixture.releaseGitStatus(1, 1))
  await expect(panel.locator(".agent-repository-file-path").first()).toHaveText("src/current.ts")
  expect(await page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(2)
})

test("binary and stale diff states are explicit, and a late selected-file result cannot replace the current file", async ({ page }) => {
  await connect(page)
  await page.evaluate(() => { (window as any).agentFixture.deferGitDiff = true })
  const panel = await openRepository(page)
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitDiffCalls.length)).toBe(1)
  await panel.getByRole("button", { name: /docs\/new note\.md/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitDiffCalls.length)).toBe(2)
  await page.evaluate(() => (window as any).agentFixture.releaseGitDiff(0, 1))
  await expect(panel.locator(".agent-repository-diff-message")).toContainText("Loading")
  await page.evaluate(() => (window as any).agentFixture.releaseGitDiff(1, 1))
  await expect(panel.locator(".agent-repository-diff .agent-code-language span").first()).toHaveText("docs/new note.md")
  expect((await page.evaluate(() => (window as any).agentFixture.gitDiffCalls.map((call: any) => call.entryId))).at(-1)).toBe("git-fixture-untracked")

  await page.evaluate(() => { const h = (window as any).agentFixture; h.deferGitDiff = false; h.gitDiffState = "binary" })
  await panel.getByRole("button", { name: /src\/current\.ts/ }).click()
  await expect(panel.locator(".agent-repository-diff-message")).toContainText("Binary content is not rendered")
  await page.evaluate(() => { (window as any).agentFixture.gitDiffState = "stale" })
  await panel.getByRole("button", { name: /docs\/new note\.md/ }).click()
  await expect(panel.locator(".agent-repository-diff-message")).toContainText("Refresh repository")

  const cases = [
    ["tooLarge", "This diff exceeds the safe preview limit."],
    ["conflict", "Resolve this merge conflict"],
    ["submodule", "Submodule contents are not traversed"],
    ["symlink", "Symbolic link content is not followed"],
    ["unsupportedPath", "This path cannot be safely opened as UTF-8 content"],
  ] as const
  for (const [state, reason] of cases) {
    await page.evaluate(state => { (window as any).agentFixture.gitDiffState = state }, state)
    const path = await page.locator(".agent-repository-file.is-selected .agent-repository-file-path").textContent()
    const next = path === "src/current.ts" ? "docs/new note.md" : "src/current.ts"
    await panel.getByRole("button", { name: new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click()
    await expect(panel.locator(".agent-repository-diff-message")).toContainText(reason)
  }
})

test("connection replacement and project changes discard late status responses", async ({ page }) => {
  await connect(page)
  await page.evaluate(() => { (window as any).agentFixture.deferGitStatus = true })
  await openRepository(page)
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(1)
  await page.evaluate(() => { const h = (window as any).agentFixture; h.gitRoot = "/srv/reconnected"; h.replaceTransport() })
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.gitStatusCalls.length)).toBe(2)
  await page.evaluate(() => (window as any).agentFixture.releaseGitStatus(1, 1))
  const panel = page.getByRole("complementary", { name: "Repository changes" })
  await expect(panel.locator(".agent-repository-identity code")).toHaveText("/srv/reconnected")
  await page.evaluate(() => (window as any).agentFixture.releaseGitStatus(0, 1))
  await expect(panel.locator(".agent-repository-identity code")).toHaveText("/srv/reconnected")
  expect(await page.evaluate(() => new Set((window as any).agentFixture.gitStatusCalls.map((call: any) => call.nativeSessionId)).size)).toBe(2)

  await panel.getByRole("button", { name: "Close changes" }).click()
  await addFolder(page, "/srv/other-project")
  await page.evaluate(() => { const h = (window as any).agentFixture; h.deferGitStatus = false; h.gitRoot = "/srv/other-project" })
  await connect(page, "Review the other project")
  const otherPanel = await openRepository(page)
  await expect(otherPanel.locator(".agent-repository-identity code")).toHaveText("/srv/other-project")
  expect((await page.evaluate(() => (window as any).agentFixture.gitStatusCalls.map((call: any) => call.cwd))).at(-1)).toBe("/srv/other-project")
})

test("repository inspector remains readable in a compact drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await connect(page)
  await page.getByRole("button", { name: "Review changes", exact: true }).click()
  const panel = page.getByRole("dialog", { name: "Repository changes" })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole("button", { name: /src\/current\.ts/ })).toBeVisible()
  const overflow = await page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>(".agent-review")!
    const repository = drawer.querySelector<HTMLElement>(".agent-repository")!
    return { drawer: drawer.scrollWidth > drawer.clientWidth + 1, repository: repository.scrollWidth > repository.clientWidth + 1 }
  })
  expect(overflow).toEqual({ drawer: false, repository: false })
})
