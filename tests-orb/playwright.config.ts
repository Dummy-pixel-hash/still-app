import { defineConfig } from "@playwright/test"
import { existsSync } from "node:fs"

export default defineConfig({
  testDir: ".",
  outputDir: "../test-results/orb",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1432",
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: process.env.STILL_TEST_BROWSER || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined),
      args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 1432",
    url: "http://127.0.0.1:1432/tests-orb/fixture.html",
    reuseExistingServer: !process.env.CI,
  },
})
