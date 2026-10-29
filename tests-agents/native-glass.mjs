import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { resolve, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "@playwright/test"
import { probeAuroraGlass } from "./glass-pixels.mjs"

assert.equal(process.platform, "win32", "This test must use the real Windows WebView2, not browser emulation")
assert.ok(process.argv[2], "Pass the packaged Still executable to test")
const executable = resolve(process.argv[2])
const output = resolve("native-glass-output")
await mkdir(output, { recursive: true })
const port = process.env.STILL_GLASS_CDP_PORT ? Number(process.env.STILL_GLASS_CDP_PORT) : await new Promise((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address()
    server.close(error => error ? reject(error) : resolve(port))
  })
})
await writeFile(join(output, "launch.json"), JSON.stringify({ executable, port, buildRun: process.env.STILL_BUILD_RUN }, null, 2))
const app = spawn(executable, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: join(process.env.RUNNER_TEMP || output, `still-glass-webview-${process.pid}`),
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let launchError
app.on("error", error => { launchError = error })
app.stdout.on("data", data => process.stdout.write(data))
app.stderr.on("data", data => process.stderr.write(data))
let browser, page
try {
  const deadline = Date.now() + 90_000
  for (;;) {
    if (launchError) throw launchError
    if (app.exitCode !== null) throw new Error(`Still exited before WebView2 became ready (${app.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error("The real application did not expose its WebView2 CDP endpoint within 90 seconds")
    await delay(250)
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  page = context.pages()[0] || await context.waitForEvent("page")
  page.setDefaultTimeout(30_000)
  await page.bringToFront()
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.getByRole("button", { name: "Agents", exact: true }).click()
  await page.locator(".agent-chat").evaluate(chat => chat.classList.remove("is-launch"))
  const results = await probeAuroraGlass(page, (name, image) => writeFile(join(output, `${name}.png`), image), [["sidebar", ".agent-sidebar"], ["composer-veil", ".agent-composer-area"]])
  const report = { executable, buildRun: process.env.STILL_BUILD_RUN, userAgent: await page.evaluate(() => navigator.userAgent), results }
  if (process.env.STILL_GLASS_DIAGNOSE === "1") {
    report.variants = []
    const variants = [
      ["opaque-document", "html, body { background-color: #050505 !important; }"],
      ["positive-layers", ".agent-aurora { z-index: 0 !important; } .agent-main, .agent-sidebar { z-index: 1 !important; }"],
      ["no-isolation", ".agent-workspace { isolation: auto !important; }"],
      ["opaque-source", ".agent-aurora { opacity: 1 !important; }"],
      ["explicit-layers", ".agent-sidebar, .agent-composer::before { transform: translateZ(0) !important; }"],
    ]
    for (const [name, css] of variants) {
      const style = await page.addStyleTag({ content: css })
      try {
        const measurements = await probeAuroraGlass(page, (imageName, image) => writeFile(join(output, `${name}-${imageName}.png`), image))
        report.variants.push({ name, measurements })
      } finally { await style.evaluate(el => el.remove()) }
    }
    const resetFrame = spawnSync("powershell.exe", ["-NoProfile", "-Command", `
      Add-Type -TypeDefinition '
        using System;
        using System.Runtime.InteropServices;
        public class GlassFrameProbe {
          [StructLayout(LayoutKind.Sequential)] public struct Margins { public int left, right, top, bottom; }
          [DllImport("dwmapi.dll")] public static extern int DwmExtendFrameIntoClientArea(IntPtr window, ref Margins margins);
          [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref uint value, int size);
        }';
      $window = [Diagnostics.Process]::GetProcessById(${app.pid}).MainWindowHandle;
      if ($window -eq [IntPtr]::Zero) { throw 'No native main-window handle'; }
      $margins = New-Object GlassFrameProbe+Margins;
      [GlassFrameProbe]::DwmExtendFrameIntoClientArea($window, [ref]$margins);
      $color = [uint32]4294967294;
      [GlassFrameProbe]::DwmSetWindowAttribute($window, 34, [ref]$color, 4);
    `], { encoding: "utf8", timeout: 15_000 })
    report.frameReset = { status: resetFrame.status, stdout: resetFrame.stdout, stderr: resetFrame.stderr }
    if (resetFrame.status === 0) {
      const measurements = await probeAuroraGlass(page, (name, image) => writeFile(join(output, `no-dwm-glass-${name}.png`), image))
      report.variants.push({ name: "no-dwm-glass", measurements })
    }
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  for (const pane of results) {
    assert.ok(pane.unblurred > 3, `${pane.name}: the actual source must be visible through the pane`)
    assert.ok(pane.ratio < .3, `${pane.name}: WebView2 did not blur the actual source (contrast ratio ${pane.ratio})`)
  }
  console.log("REAL WINDOWS WEBVIEW2 BLUR VERIFIED")
} catch (error) {
  await writeFile(join(output, "error.txt"), String(error.stack || error))
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {})
  throw error
} finally {
  await browser?.close().catch(() => {})
  if (app.pid && app.exitCode === null) spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"])
}
