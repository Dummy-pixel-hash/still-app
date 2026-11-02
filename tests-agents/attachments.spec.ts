import { test, expect } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/__impeccable/**", route => route.abort())
  await page.route("**/live.js?*", route => route.abort())
  await page.goto("/tests-agents/fixture.html")
  await page.getByRole("button", { name: "Add project folder", exact: true }).click()
  await page.getByLabel("Remote project folder").fill("/srv/still")
  await page.getByRole("button", { name: "Open folder", exact: true }).click()
})

test("picker attachments upload before an attachment-only prompt and remain visible in history", async ({ page }) => {
  await page.getByLabel("Choose message attachments").setInputFiles({
    name: "shot.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  })
  await expect(page.getByText("shot.png", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.locator(".agent-message-user")).toContainText("shot.png")
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.uploads.length)).toBe(1)
  const upload = await page.evaluate(() => (window as any).agentFixture.uploads[0])
  expect(upload).toMatchObject({ fileName: "shot.png", bytes: 8 })
  const sent = await page.evaluate(() => (window as any).agentFixture.sends[0])
  expect(sent).toContain("Attached files uploaded to this server")
  expect(sent).toContain("`shot.png`: `/home/dev/still-uploads/agents/")
  await expect(page.locator(".agent-composer .agent-attachment")).toHaveCount(0)
})

test("attachment limits reject oversized files without dropping the current draft", async ({ page }) => {
  await page.getByLabel("Message agent").fill("Keep this request")
  await page.getByLabel("Choose message attachments").setInputFiles({
    name: "large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  })
  await expect(page.getByRole("alert")).toContainText("Each attachment must be 5 MB or smaller")
  await expect(page.getByLabel("Message agent")).toHaveValue("Keep this request")
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled()
})

test("removing an attachment only clears that file", async ({ page }) => {
  await page.getByLabel("Choose message attachments").setInputFiles([
    { name: "one.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "two.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ])
  await page.getByRole("button", { name: "Remove one.txt" }).click()
  await expect(page.getByText("one.txt", { exact: true })).toHaveCount(0)
  await expect(page.getByText("two.txt", { exact: true })).toBeVisible()
})

test("image paste and drag-and-drop add files without replacing the prompt", async ({ page }) => {
  const composer = page.locator(".agent-composer")
  await page.getByLabel("Message agent").fill("Look at these")
  await page.getByLabel("Message agent").evaluate(element => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(["image one"], "pasted.png", { type: "image/png" }))
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }))
  })
  await expect(page.getByText("pasted.png", { exact: true })).toBeVisible()
  await composer.evaluate(element => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(["image two"], "dropped.jpg", { type: "image/jpeg" }))
    element.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }))
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await expect(page.getByText("dropped.jpg", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Message agent")).toHaveValue("Look at these")
})

test("the attach control is hidden while the current-conversation composer is collapsed", async ({ page }) => {
  const composer = page.locator(".agent-composer")
  await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible()
  await composer.evaluate(element => element.classList.add("is-collapsed"))
  await expect(page.getByRole("button", { name: "Attach files" })).toBeHidden()
  await composer.evaluate(element => element.classList.remove("is-collapsed"))
  await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible()
})

test("failed upload keeps the attachment for a safe retry", async ({ page }) => {
  await page.getByLabel("Choose message attachments").setInputFiles({
    name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("keep me"),
  })
  await page.evaluate(() => { (window as any).agentFixture.rejectUpload = true })
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("SFTP disconnected during upload")
  await expect(page.locator(".agent-composer .agent-attachment")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled()
  await page.evaluate(() => { (window as any).agentFixture.rejectUpload = false })
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.locator(".agent-message-user")).toContainText("notes.txt")
  expect(await page.evaluate(() => (window as any).agentFixture.sends)).toHaveLength(1)
})

test("staged file metadata and bytes survive navigation reload", async ({ page }) => {
  await page.getByLabel("Message agent").fill("Review this later")
  await page.getByLabel("Choose message attachments").setInputFiles({
    name: "later.md", mimeType: "text/markdown", buffer: Buffer.from("persistent draft file"),
  })
  await expect(page.getByText("later.md", { exact: true })).toBeVisible()
  await page.evaluate(async () => await (window as any).agentFixture.flush())
  await page.reload()
  await page.getByRole("button", { name: "Choose project" }).click()
  await page.locator(".agent-context-choices .agent-project-choice").click()
  await expect(page.getByLabel("Message agent")).toHaveValue("Review this later")
  await expect(page.getByText("later.md", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).agentFixture.uploads.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).agentFixture.uploads[0].bytes)).toBe(Buffer.byteLength("persistent draft file"))
})
