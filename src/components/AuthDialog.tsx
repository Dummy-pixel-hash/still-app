import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { Session } from "../types"
import { nativeBridge } from "../bridge/nativeBridge"

/**
 * Transient auth prompt. The secret is returned to the caller for a single
 * connect attempt and never persisted by the renderer. `remember` asks the
 * NATIVE side to persist into the OS keyring.
 */
export default function AuthDialog({
  session,
  mode,
  onResolve,
}: {
  session: Session
  mode: "password" | "key"
  onResolve: (answer: { secret?: string; remember: boolean } | null) => void
}) {
  const [secret, setSecret] = useState("")
  const [remember, setRemember] = useState(session.remember)
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [stored, setStored] = useState<boolean | null>(null)

  useEffect(() => {
    fieldRef.current?.focus()
    if (session.authMethod === "password") {
      void nativeBridge
        .hasCredential(session.host, session.port, session.username)
        .then(setStored)
        .catch(() => setStored(false))
    }
  }, [session])

  // Portalled to document.body: the workspace container underneath gets
  // pointer-events:none while the terminal overlay is open, which would
  // otherwise make this prompt unclickable.
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Authenticate ${session.name}`}
      onClick={() => onResolve(null)}
    >
      <div
        className="w-full max-w-sm rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-2xl text-fg">Connect</h2>
        <p className="mt-1 font-mono text-[11px] text-faint">
          {session.username}@{session.host}:{session.port} · tmux{" "}
          {session.tmuxSession}
        </p>
        {stored ? (
          <p className="mt-3 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[12px] text-dim">
            A secret is remembered on this device (OS keyring). Leave blank to
            reuse it, or enter a new one.
          </p>
        ) : null}
        {mode === "password" ? (
          <input
            type="password"
            ref={fieldRef as React.RefObject<HTMLInputElement>}
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={
              stored ? "Password (blank = use remembered)" : "Password"
            }
            aria-label="Password"
            className="mt-3 w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-[13px] text-fg outline-none focus:border-[#ff4a4a]/50"
            onKeyDown={(e) => {
              if (e.key === "Enter")
                onResolve({ secret: secret || undefined, remember })
            }}
          />
        ) : (
          <textarea
            ref={fieldRef as React.RefObject<HTMLTextAreaElement>}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Paste private key (single connect only)"
            aria-label="Private key"
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="mt-3 w-full resize-y rounded-lg border border-white/10 bg-black/50 px-3 py-2 font-mono text-[12px] text-fg outline-none focus:border-[#ff4a4a]/50"
          />
        )}
        <label className="mt-3 flex items-center gap-2 text-[12px] text-dim">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-[#ff4a4a]"
          />
          Remember on this device{" "}
          <span className="font-mono text-[10px] text-faint">
            (OS keyring, native only)
          </span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve(null)}
            className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onResolve({ secret: secret || undefined, remember })}
            className="rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
          >
            Connect
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
