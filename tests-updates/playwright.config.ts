import { defineConfig } from "@playwright/test"
import { existsSync } from "node:fs"

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1441",
    viewport: { width: 1100, height: 720 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    launchOptions: {
      executablePath: process.env.STILL_TEST_BROWSER || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined),
      args: ["--no-sandbox", "--disable-gpu"],
    },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1441",
    url: "http://127.0.0.1:1441/tests-updates/fixture.html",
    reuseExistingServer: !process.env.CI,
  },
})
