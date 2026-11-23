import type { Page } from "@playwright/test"

/** The compact desktop header and full sidebar expose different native labels. */
export function projectSidebarToggle(page: Page) {
  return page.getByRole("button", { name: /^(?:Expand|Collapse) project sidebar$|^Show projects(?: ·.*)?$/ }).filter({ visible: true }).first()
}

export async function openAgentSettings(page: Page) {
  await page.getByRole("button", { name: "Agent settings", exact: true }).filter({ visible: true }).first().click()
}
