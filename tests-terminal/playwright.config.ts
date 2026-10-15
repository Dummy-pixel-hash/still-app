import { defineConfig } from "@playwright/test"
import { existsSync } from "node:fs"

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1431",
    // Wide enough for the 3-column workspace card grid: the preview's fit
    // target depends on the real card width.
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: process.env.STILL_TEST_BROWSER || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined),
    },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1431",
    url: "http://127.0.0.1:1431/tests-terminal/fixture.html",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "terminal",
      testIgnore: "preview.spec.ts",
    },
    {
      name: "preview",
      testMatch: "preview.spec.ts",
    },
  ],
})
