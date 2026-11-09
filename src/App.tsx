import { lazy, Suspense, useEffect } from "react"
import { diagRecord } from "./session/diag"
import { isMobileClient } from "./mobile/platform"

const MobileApp = lazy(() => import("./mobile/MobileApp"))
const Workspace = lazy(() => import("./screens/Workspace"))

export default function App() {
  // DIAG-ONLY: WebView-side startup marker + one harmless IPC health
  // check ("can the packaged WebView invoke ANY Tauri command?") via a
  // dynamic import so the mock/dev bridges stay usable without the Tauri
  // runtime. Fire-and-forget; never gates or alters connecting.
  useEffect(() => {
    diagRecord({ stage: "APP_START", localId: "" })
    const t0 = Date.now()
    diagRecord({ stage: "PING_START", localId: "" })
    void (async () => {
      try {
        const [core, bridge] = await Promise.all([
          import("@tauri-apps/api/core"),
          import("./bridge/tauriBridge"),
        ])
        void core;
        const res = await bridge.tauriBridge.ping()
        void res;
        diagRecord({
          stage: "PING_RESOLVED",
          localId: "",
          elapsedMs: Date.now() - t0,
        })
      } catch (e: unknown) {
        diagRecord({
          stage: "PING_REJECTED",
          localId: "",
          ok: false,
          code: "rejected",
          message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
          elapsedMs: Date.now() - t0,
        })
      }
    })()
  }, [])
  const Surface = isMobileClient() ? MobileApp : Workspace
  return <Suspense fallback={<div style={{ height: "100%", background: "#080809" }} />}><Surface /></Suspense>
}
