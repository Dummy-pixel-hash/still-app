// Explicit browser-only IPC fixture. It never runs in the production application.
import React from "react"
import { createRoot } from "react-dom/client"
import { mockIPC } from "@tauri-apps/api/mocks"
import UpdateNotice, { UpdateSettings } from "../src/updates/UpdateNotice"
import "../src/styles/theme.css"

const scenario = new URLSearchParams(location.search).get("scenario") || "windows"
const calls: string[] = []
let release: () => void = () => {}
let rejectDownload: () => void = () => {}
let failedOnce = false
let installFailedOnce = false
if (scenario !== "browser") mockIPC((command, payload) => {
  const args = (payload || {}) as Record<string, unknown>
  calls.push(`${command}:${args.action || ""}`)
  if (command === "plugin:app|bundle_type") return scenario === "msi" ? "msi" : "nsis"
  if (command === "plugin:updater|check") {
    if (scenario === "offline" && !failedOnce) { failedOnce = true; throw new Error("Offline: test connection failed") }
    return { rid: 10, currentVersion: "0.1.1", version: "0.1.2", rawJson: {} }
  }
  if (command === "plugin:updater|download") {
    const channel = args.onEvent as { onmessage: (value: unknown) => void }
    channel.onmessage({ event: "Started", data: { contentLength: 100 } })
    channel.onmessage({ event: "Progress", data: { chunkLength: 100 } })
    channel.onmessage({ event: "Finished" })
    return new Promise<number>((resolve, reject) => {
      release = () => resolve(20)
      rejectDownload = () => reject(new Error("Signature verification failed"))
    })
  }
  if (command === "plugin:updater|install" && scenario === "install-failure" && !installFailedOnce) {
    installFailedOnce = true
    throw new Error("The installer could not be started")
  }
  if (command === "still_android_update") {
    const value = { phase: "ready", version: "0.1.2", progress: 100, allowCellular: false, message: "Verified and ready to install." }
    if (args.action === "setCellular") return { ...value, phase: "idle", allowCellular: args.allowCellular === true }
    if (args.action === "install") return { ...value, message: "Allow updates from Still, then return and choose Install update again." }
    return value
  }
  return null
})
Object.assign(window, { updateTest: { calls, release: () => release(), rejectDownload: () => rejectDownload() } })
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <main style={{ maxWidth: 600, margin: "32px auto", padding: 20 }}><h1>Still settings</h1><UpdateSettings /></main>
  <UpdateNotice />
</React.StrictMode>)
