import { useEffect, useRef, useState } from "react"
import { getBundleType } from "@tauri-apps/api/app"
import { invoke } from "@tauri-apps/api/core"
import { check, type Update } from "@tauri-apps/plugin-updater"

const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const CHECK_EVENT = "still:check-updates"
const LAST_CHECK_KEY = "still.updates.last-check.v1"

type UpdateState = {
  phase: "idle" | "checking" | "waiting" | "downloading" | "verifying" | "ready" | "installing" | "disabled" | "failed"
  message: string
  version?: string
  progress?: number
  allowCellular?: boolean
}

export function platform(): "android" | "windows" | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null
  if (/Android/i.test(navigator.userAgent)) return "android"
  return /Windows/i.test(navigator.userAgent) ? "windows" : null
}

function android(action: "check" | "status" | "install" | "setCellular", options = {}) {
  return invoke<UpdateState>("still_android_update", { action, ...options })
}

/** Native-only Settings controls; browser previews and other OSes have no dead update buttons. */
export function UpdateSettings() {
  const [cellular, setCellular] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const os = platform()
  useEffect(() => {
    let alive = true
    if (os === "android") void android("status").then(value => {
      if (alive) setCellular(value.allowCellular === true)
    }).catch(() => { if (alive) setError("Could not read update preferences. Reopen Settings to retry.") })
    return () => { alive = false }
  }, [os])
  if (!os) return null
  return <section className="mt-6 border-t border-white/10 pt-4 text-sm">
    <h3 className="font-medium text-fg">App updates</h3>
    <p className="mt-1 text-dim">Stable releases download automatically. Installation is always your choice.</p>
    <button className="mt-3 min-h-11 rounded-lg border border-white/15 px-3 text-fg hover:bg-white/5 focus-visible:outline focus-visible:outline-2" onClick={() => window.dispatchEvent(new Event(CHECK_EVENT))}>Check for updates</button>
    {os === "android" && <label className="mt-3 flex min-h-11 items-center gap-3 text-fg">
      <input type="checkbox" checked={cellular} disabled={saving} onChange={event => {
        const next = event.target.checked
        setSaving(true)
        setError("")
        void android("setCellular", { allowCellular: next }).then(value => {
          setCellular(value.allowCellular === true)
          window.dispatchEvent(new Event(CHECK_EVENT))
        }).catch(() => setError("Could not save the download preference. Please try again."))
          .finally(() => setSaving(false))
      }} />Allow downloads on metered/cellular networks
    </label>}
    {os === "android" && <p className="mt-1 text-xs text-dim">Otherwise downloads wait for an unmetered connection. Changing this setting restarts any pending download.</p>}
    {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
  </section>
}

export default function UpdateNotice() {
  const [state, setState] = useState<UpdateState>({ phase: "idle", message: "" })
  const [visible, setVisible] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const update = useRef<Update | null>(null)
  const checkNow = useRef<(force: boolean) => Promise<void>>(async () => {})
  const os = platform()

  useEffect(() => {
    if (!os) return
    let alive = true
    let checking = false
    let downloading = false
    let lastAttempt = 0
    const apply = (value: UpdateState) => { if (alive) setState(value) }
    const checkForUpdate = async (force: boolean) => {
      if (force) { setVisible(true); setConfirm(false) }
      if (checking || update.current) return
      const now = Date.now()
      if (!force && now - lastAttempt < 60_000) return
      if (os === "windows" && !force) {
        try {
          const previous = Number(localStorage.getItem(LAST_CHECK_KEY))
          if (previous > 0 && previous <= now && now - previous < CHECK_INTERVAL) return
        } catch { /* Storage may be unavailable; checking must still work. */ }
      }
      lastAttempt = now
      checking = true
      apply({ phase: "checking", message: "Checking GitHub for a newer stable release…" })
      try {
        if (os === "android") {
          const value = await android("check", { force })
          apply(value)
          if (alive && value.phase === "ready") setVisible(true)
          return
        }
        if (await getBundleType() !== "nsis") {
          apply({ phase: "disabled", message: "Automatic Windows updates support NSIS installations. Development and MSI builds need a one-time manual installation of the NSIS release." })
          return
        }
        const found = await check({ timeout: 20_000 })
        if (!alive) { await found?.close(); return }
        if (!found) {
          apply({ phase: "idle", message: "You’re up to date. No newer stable release is available." })
        } else {
          update.current = found
          if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(found.version)) throw new Error("The update feed returned a non-stable version.")
          let received = 0
          let total: number | undefined
          downloading = true
          apply({ phase: "downloading", version: found.version, message: "Downloading the signed update in the background…" })
          await found.download(event => {
            if (event.event === "Started") total = event.data.contentLength
            if (event.event === "Progress") received += event.data.chunkLength
            apply({
              phase: event.event === "Finished" ? "verifying" : "downloading",
              version: found.version,
              message: event.event === "Finished" ? "Verifying the update signature…" : "Downloading in the background…",
              progress: total && total > 0 ? Math.min(99, Math.floor(received * 100 / total)) : undefined,
            })
          }, { timeout: 5 * 60_000 })
          // Finished only means the last byte arrived. Do not enable installation until
          // download() resolves, after the plugin has verified the package signature.
          apply({ phase: "ready", version: found.version, progress: 100, message: "Signature verified. The update is ready to install." })
          if (alive) setVisible(true)
        }
        try { localStorage.setItem(LAST_CHECK_KEY, String(Date.now())) } catch { /* Nonessential cache. */ }
      } catch (reason) {
        if (update.current) { await update.current.close().catch(() => {}); update.current = null }
        apply({ phase: "failed", message: reason instanceof Error ? reason.message : String(reason) })
        if (!force) console.warn("[still] Background update check failed:", reason)
      } finally {
        downloading = false
        checking = false
        if (!alive && update.current) { await update.current.close().catch(() => {}); update.current = null }
      }
    }
    checkNow.current = checkForUpdate
    const manual = () => { void checkForUpdate(true) }
    const foreground = () => { if (document.visibilityState === "visible") void checkForUpdate(false) }
    const startup = window.setTimeout(() => { void checkForUpdate(false) }, 1500)
    const interval = window.setInterval(() => { void checkForUpdate(false) }, CHECK_INTERVAL)
    window.addEventListener(CHECK_EVENT, manual)
    document.addEventListener("visibilitychange", foreground)
    return () => {
      alive = false
      window.clearTimeout(startup)
      window.clearInterval(interval)
      window.removeEventListener(CHECK_EVENT, manual)
      document.removeEventListener("visibilitychange", foreground)
      if (!downloading && update.current) { void update.current.close().catch(() => {}); update.current = null }
    }
  }, [os])

  useEffect(() => {
    if (os !== "android" || !["waiting", "downloading", "verifying"].includes(state.phase)) return
    let alive = true
    let polling = false
    const timer = window.setInterval(() => {
      if (polling) return
      polling = true
      void android("status").then(value => {
        if (!alive) return
        setState(value)
        if (value.phase === "ready") setVisible(true)
      }).catch(reason => {
        if (alive) setState({ phase: "failed", message: String(reason) })
      }).finally(() => { polling = false })
    }, 2000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [os, state.phase])

  const install = async () => {
    if (state.phase !== "ready") return
    setConfirm(false)
    setState({ ...state, phase: "installing", message: "Opening the installer…" })
    try {
      if (os === "android") setState(await android("install"))
      else if (update.current) await update.current.install({ restartAfterInstall: true })
      else throw new Error("The verified download is no longer available. Check for updates again.")
    } catch (reason) {
      // A failed Windows installation may have consumed the backend byte resource.
      // Recheck/redownload instead of repeatedly installing an invalid resource ID.
      if (os === "windows" && update.current) {
        await update.current.close().catch(() => {})
        update.current = null
      }
      setState({ ...state, phase: "failed", message: `Installation did not finish: ${String(reason)}. Check for updates to retry.` })
    }
  }

  if (!os || !visible) return null
  const button = "min-h-11 rounded-lg border border-white/15 px-3 text-sm hover:bg-white/5 focus-visible:outline focus-visible:outline-2 disabled:opacity-50"
  return <aside className="fixed right-4 z-[100] max-h-[50dvh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-white/15 bg-s2 p-4 text-sm text-fg" style={{ bottom: os === "android" ? "max(6rem, env(safe-area-inset-bottom))" : "1rem" }} aria-label="App update">
    <div className="flex items-center justify-between gap-3">
      <strong>App updates{state.version ? ` · ${state.version}` : ""}</strong>
      <button className={button} disabled={state.phase === "installing"} onClick={() => { setVisible(false); setConfirm(false) }}>Later</button>
    </div>
    <p className="mt-2 break-words text-dim" role="status" aria-live="polite">{state.message}</p>
    {["downloading", "waiting", "verifying"].includes(state.phase) && <progress className="mt-3 w-full accent-red" aria-label="Update download progress" value={state.progress} max={100} />}
    {confirm ? <div className="mt-3">
      <p>Save unfinished work first. Still may close and local processes will stop. Remote sessions need to reconnect after the update.</p>
      <div className="mt-3 flex flex-wrap gap-2"><button className={button} onClick={() => void install()}>Install now</button><button className={button} onClick={() => setConfirm(false)}>Cancel</button></div>
    </div> : state.phase === "ready" ? <button className={`${button} mt-3`} onClick={() => setConfirm(true)}>{os === "android" ? "Install update" : "Install and restart"}</button> : null}
    {["failed", "idle"].includes(state.phase) && <button className={`${button} mt-3`} onClick={() => void checkNow.current(true)}>{state.phase === "failed" ? "Retry update check" : "Check again"}</button>}
  </aside>
}
