import "./styles/theme.css"
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { failingBridge, registerNativeBridge } from "./bridge/nativeBridge"
import { mockBridge } from "./bridge/mockBridge"
import { tauriBridge } from "./bridge/tauriBridge"

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  )
}

// Bridge selection:
// - Tauri runtime present            -> real tauriBridge (dev AND prod).
// - Browser dev (`vite dev`/preview) -> mockBridge (explicit local UI sim).
// - PRODUCTION bundle w/o runtime    -> failingBridge: LOUD hard failure,
//   never a silent SSH simulation.
// Production = bundled assets served ONLY inside the Tauri WebView,
// where __TAURI_INTERNALS__ is always present. Vite sets
// import.meta.env.PROD for `vite build` output (which is what the
// Tauri bundle ships), while `vite dev` is DEV.
const PROD = import.meta.env.PROD === true
if (isTauriRuntime()) {
  registerNativeBridge(tauriBridge)
} else if (PROD) {
  console.error(
    "[still] FATAL: production bundle has no Tauri native runtime. " +
      "Refusing to simulate SSH — reinstall the application.",
  )
  registerNativeBridge(failingBridge)
} else {
  registerNativeBridge(mockBridge)
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
