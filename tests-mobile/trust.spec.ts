import { expect, test } from "@playwright/test"
import { nativeErrorMessage } from "../src/bridge/errors"

test("serialized native errors preserve the useful message", () => {
  expect(nativeErrorMessage({ code: "keyring", message: "Could not persist host trust: permission denied." }, "fallback")).toContain("permission denied")
  expect(nativeErrorMessage(new Error("network down"), "fallback")).toBe("network down")
  expect(nativeErrorMessage("invalid server", "fallback")).toBe("invalid server")
  expect(nativeErrorMessage({ secret: "must not be rendered" }, "fallback")).toBe("fallback")
})

test("the mobile project sheet has one readable host verification panel", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/tests-mobile/trust-fixture.html")
  const dialog = page.getByRole("dialog", { name: "Choose a project", exact: true })
  await dialog.getByRole("combobox", { name: "Project server" }).selectOption(JSON.stringify(["fixture.invalid", 22, "fixture"]))
  await expect(dialog.getByRole("region", { name: "Verify server identity" })).toHaveCount(1)
  await expect(dialog).toHaveCSS("background-color", "rgb(13, 10, 16)")
  await expect(dialog).toHaveCSS("backdrop-filter", "none")
  const notice = dialog.getByRole("region", { name: "Verify server identity" })
  await expect(notice).toContainText("Check this fingerprint before trusting")
  await notice.getByRole("button", { name: "Trust and connect", exact: true }).click()
  await expect(notice.getByRole("alert")).toHaveText("Could not persist host trust: fixture storage is not writable.")
  await expect(notice.getByRole("button", { name: "Trust and connect", exact: true })).toBeEnabled()
  await expect(notice.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
})
