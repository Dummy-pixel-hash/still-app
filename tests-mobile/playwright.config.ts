import { defineConfig } from "@playwright/test"
import { existsSync } from "node:fs"
export default defineConfig({
  testDir: ".", testMatch: "*.spec.ts", workers: 1,
  use: { baseURL: "http://127.0.0.1:1433", viewport: { width: 393, height: 852 }, hasTouch: true, launchOptions: { executablePath: process.env.STILL_TEST_BROWSER || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined), args: ["--no-sandbox", "--disable-gpu"] } },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 1433", url: "http://127.0.0.1:1433/tests-mobile/fixture.html", reuseExistingServer: !process.env.CI },
})
