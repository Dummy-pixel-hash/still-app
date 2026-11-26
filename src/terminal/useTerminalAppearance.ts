import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { tempAppearanceFor, useStore } from "../session/store"
import type { Session } from "../types"
import {
  DEFAULT_ENV,
  resolveTerminalAppearance,
  type AppearanceEnv,
  type ResolvedAppearance,
} from "./appearance"

function query(q: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q) : null
}

/** Tracks the OS reduced-motion and more-contrast preferences live. */
export function useMediaPrefs(): AppearanceEnv {
  const [env, setEnv] = useState<AppearanceEnv>(() => ({
    reducedMotion: query("(prefers-reduced-motion: reduce)")?.matches ?? false,
    moreContrast: query("(prefers-contrast: more)")?.matches ?? false,
  }))
  useEffect(() => {
    const motion = query("(prefers-reduced-motion: reduce)")
    const contrast = query("(prefers-contrast: more)")
    const sync = () =>
      setEnv((prev) => {
        const next = { reducedMotion: motion?.matches ?? false, moreContrast: contrast?.matches ?? false }
        return prev.reducedMotion === next.reducedMotion && prev.moreContrast === next.moreContrast ? prev : next
      })
    sync()
    motion?.addEventListener("change", sync)
    contrast?.addEventListener("change", sync)
    return () => {
      motion?.removeEventListener("change", sync)
      contrast?.removeEventListener("change", sync)
    }
  }, [])
  return env
}

// resolveTerminalAppearance builds fresh objects on every call. Cards and the
// overlay are memoized on the result, so hand back the SAME object while every
// effective value is unchanged.
const stable = new Map<string, ResolvedAppearance>()

function same(a: ResolvedAppearance, b: ResolvedAppearance): boolean {
  return (
    a.theme === b.theme &&
    a.fontSize === b.fontSize &&
    a.cursorStyle === b.cursorStyle &&
    a.cursorBlink === b.cursorBlink &&
    a.scrollback === b.scrollback &&
    a.minimumContrastRatio === b.minimumContrastRatio &&
    a.screenReaderMode === b.screenReaderMode &&
    a.visualBell === b.visualBell &&
    a.sources.theme === b.sources.theme &&
    a.sources.fontSize === b.sources.fontSize
  )
}

type StoreView = ReturnType<typeof useStore>

/** Resolve one session's appearance against the live store (identity-stable). */
export function resolveSessionAppearance(
  store: Pick<StoreView, "sessions" | "settings">,
  id: string,
  env: AppearanceEnv = DEFAULT_ENV,
  fallback?: Pick<Session, "terminalTheme" | "fontSize"> | null,
): ResolvedAppearance {
  const temp = id.startsWith("temp-")
  const live = temp ? tempAppearanceFor(id) : store.sessions.find((s) => s.id === id) ?? fallback
  const next = resolveTerminalAppearance(live, store.settings, env)
  const prev = stable.get(id)
  if (prev && same(prev, next)) return prev
  stable.set(id, next)
  return next
}

export function forgetAppearance(id: string) {
  stable.delete(id)
}

/**
 * Appearance of one session, read from the LIVE store. The snapshot a parent
 * holds (e.g. `open.session`) goes stale as soon as the user changes a theme
 * or zooms, so surfaces must resolve through this hook instead.
 */
export function useTerminalAppearance(
  id: string,
  fallback?: Pick<Session, "terminalTheme" | "fontSize"> | null,
): ResolvedAppearance {
  const store = useStore()
  const env = useMediaPrefs()
  // `version` bumps on every store change, including temp-session overrides.
  return useMemo(
    () => resolveSessionAppearance(store, id, env, fallback),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store.version, store.settings, store.sessions, id, env, fallback?.terminalTheme, fallback?.fontSize],
  )
}

/** CSS custom properties exposing the resolved terminal palette to surfaces. */
export function terminalCssVars(appearance: ResolvedAppearance): CSSProperties {
  const light = appearance.theme.kind === "light"
  return {
    "--term-bg": appearance.theme.colors.background,
    "--term-fg": appearance.theme.colors.foreground,
    "--term-preview-fg": appearance.previewForeground,
    "--term-cursor": appearance.theme.colors.cursor,
    "--term-thumb": light ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.25)",
    "--term-thumb-hover": light ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.4)",
  } as CSSProperties
}
