// Temporary Windows-connection diagnostics (DIAGNOSTICS ONLY).
//
// Fire-and-forget frontend checkpoint sink: forwards stage records to the
// Rust `still_diag_record` command, which appends them to the same
// deterministic per-user log (%LOCALAPPDATA%\Still\logs\still-diag.log on
// Windows). Falls back to console.debug when the Tauri IPC channel itself
// is unreachable. NEVER logs secrets — ids + stages + short codes only.

interface DiagRecord {
  stage: string
  localId: string
  nativeId?: string
  ok?: boolean
  code?: string
  message?: string
  elapsedMs?: number | null
}

// Dynamic invoke import keeps the mock/dev bridge usable when the Tauri
// runtime is absent (tests, browser dev). Cache the loader outcome.
let invokeFn: ((cmd: string, args?: unknown) => Promise<unknown>) | null = null
let invokeTried = false

async function getInvoke(): Promise<
  ((cmd: string, args?: unknown) => Promise<unknown>) | null
> {
  if (invokeFn || invokeTried) return invokeFn
  invokeTried = true
  try {
    const mod = await import("@tauri-apps/api/core")
    invokeFn = mod.invoke as (cmd: string, args?: unknown) => Promise<unknown>
  } catch {
    invokeFn = null
  }
  return invokeFn
}

/** Truncate + single-line a free-form field (code/message). */
function cap(s: string, n = 200): string {
  const one = s.replace(/[\r\n]+/g, " ")
  return one.length > n ? `${one.slice(0, n)}…` : one
}

function classifyError(e: unknown): { code: string; message: string } {
  if (e && typeof e === "object") {
    const rec = e as { code?: unknown; message?: unknown }
    const code =
      typeof rec.code === "string" && rec.code ? rec.code : "rejected"
    const message =
      typeof rec.message === "string" && rec.message
        ? rec.message
        : (() => {
            try {
              return JSON.stringify(e).slice(0, 200)
            } catch {
              return String(e)
            }
          })()
    return { code: cap(code, 80), message: cap(message) }
  }
  return {
    code: "rejected",
    message: cap(e instanceof Error ? e.message : String(e)),
  }
}

/**
 * Fire-and-forget diagnostic record. Never throws, never awaits the caller:
 * returns immediately so diagnostics can never alter connection timing or
 * semantics.
 */
export function diagRecord(r: DiagRecord): void {
  const payload = {
    stage: r.stage,
    localId: r.localId ?? "",
    nativeId: r.nativeId ?? "",
    ok: r.ok ?? true,
    code: r.code ?? "",
    message: r.message ? cap(r.message) : "",
    elapsedMs: r.elapsedMs ?? null,
  }
  // WebView IPC queue: do not await — fire and forget.
  void (async () => {
    try {
      const invoke = await getInvoke()
      if (!invoke) {
        // eslint-disable-next-line no-console
        console.debug("[still-diag]", payload)
        return
      }
      await invoke("still_diag_record", { args: payload })
    } catch {
      // Diagnostics must never break the product path.
    }
  })()
}

export function diagOk(
  stage: string,
  localId: string,
  nativeId?: string,
  elapsedMs?: number,
): void {
  diagRecord({ stage, localId, nativeId, ok: true, elapsedMs: elapsedMs ?? null })
}

export function diagFail(
  stage: string,
  localId: string,
  e: unknown,
  nativeId?: string,
  elapsedMs?: number,
): void {
  const { code, message } = classifyError(e)
  diagRecord({ stage, localId, nativeId, ok: false, code, message, elapsedMs: elapsedMs ?? null })
}

/**
 * DIAG-ONLY stage watchdog: logs a WARNING record if `promise` has not
 * settled after `ms`. Does NOT time out, cancel, or otherwise touch the
 * operation — purely identifies which stage hangs.
 */
export function diagWatchdog<T>(
  stage: string,
  localId: string,
  promise: Promise<T>,
  ms = 5000,
): void {
  const t0 = Date.now()
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  setTimeout(() => {
    if (!settled) {
      diagRecord({
        stage: `${stage}_WATCHDOG_UNSETTLED_AFTER_${ms}MS`,
        localId,
        ok: false,
        code: "watchdog",
        message: `still pending after ${Date.now() - t0}ms (diagnostic only, operation continues)`,
      })
    }
  }, ms)
  // Unref in runtimes that support it (node tests); harmless in browsers.
  // (setTimeout above is intentionally not captured; nothing to unref.)
}
