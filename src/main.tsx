import "./styles/theme.css"
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import OrbScreen from "./screens/OrbScreen"
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

// The orb is a second window in the bundle that reuses the SAME assets at
// `?orb=1` — rendering ONLY the companion circle (never the workspace).
const isOrbRoute =
  typeof window !== "undefined" &&
  (window.location.search.includes("orb=1") || window.location.hash.includes("orb=1"))

if (isOrbRoute && typeof document !== "undefined") {
  // The orb window is transparent at the OS level (tauri.conf), but the
  // shared theme paints html/body/#root opaque — that mismatch is the
  // "black box" behind the circle. Force transparency before first paint.
  const css = "transparent !important"
  document.documentElement.style.setProperty("background", css)
  document.body?.style.setProperty("background", css)
  document.body?.style.setProperty("overflow", "hidden")
  window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("root")?.style.setProperty("background", css)
  })
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isOrbRoute ? <OrbScreen /> : <App />}</React.StrictMode>,
)
