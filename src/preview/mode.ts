/** Explicit, browser-only demo mode. Native builds always use the real store. */
export function isTerminalPreview(): boolean {
  return import.meta.env.DEV && typeof window !== "undefined" &&
    !("__TAURI_INTERNALS__" in window || "__TAURI__" in window) &&
    new URLSearchParams(window.location.search).get("preview") === "terminal"
}

export const TERMINAL_PREVIEW_STORE_KEY = "still.preview.terminals.store.v1"
