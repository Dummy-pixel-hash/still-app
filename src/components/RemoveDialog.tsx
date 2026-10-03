import { useState } from "react"
import { createPortal } from "react-dom"
import type { Session } from "../types"
import { removeSession, useStore } from "../session/store"
import { releaseSession } from "../session/connections"
import { nativeBridge } from "../bridge/nativeBridge"

/**
 * Remove confirmation honoring the `confirmRemove` setting. Removing deletes
 * the local session handle (and drops its live channel if any) — the remote
 * tmux runtime itself is left alone server-side.
 */
export default function RemoveDialog({
  session,
  onClose,
}: {
  session: Session
  onClose: () => void
}) {
  const store = useStore()
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    setBusy(true)
    try {
      // Full local release: drops our channel if live AND frees the
      // renderer's transcript/registry state for the id. Remote tmux keeps
      // running server-side.
      await releaseSession(session.id)
      removeSession(session.id)
      // Drop any remembered per-connection credential handle only on
      // explicit user intent — keep key-library secrets untouched.
      if (session.authMethod === "password") {
        try {
          await nativeBridge.forgetCredential(
            session.host,
            session.port,
            session.username,
          )
        } catch {
          // Credential may never have been remembered; removal still stands.
        }
      }
    } finally {
      setBusy(false)
      onClose()
    }
  }

  // Portalled to document.body for the same reason as AuthDialog.
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
      role="alertdialog"
      aria-modal="true"
      aria-label={`Remove ${session.name}`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-2xl text-fg">Remove session?</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-dim">
          <span className="text-fg">{session.name}</span> ({session.username}@
          {session.host}) will be removed from this workspace. The remote tmux
          session <span className="font-mono text-[12px]">{session.tmuxSession}</span>{" "}
          keeps running server-side.
        </p>
        {!store.settings.confirmRemove ? null : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
          >
            Keep
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
            className="rounded-full bg-[#b3161c] px-5 py-2 text-[13px] font-medium text-white transition hover:bg-[#d31a21] disabled:opacity-50"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
