/** Android gets a separate application shell; narrow desktop windows do not. */
export function isMobileClient(): boolean {
  if (typeof window === "undefined") return false
  const native = "__TAURI_INTERNALS__" in window || "__TAURI__" in window
  if (native && /Android/i.test(navigator.userAgent)) return true
  // Explicit UI-development route only. Production never simulates Android/SSH.
  return import.meta.env.DEV && new URLSearchParams(location.search).get("mobile") === "1"
}
