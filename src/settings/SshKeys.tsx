import { useEffect, useState } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import { addKey, removeKey, renameKey, useStore } from "../session/store"
import { inputClass } from "./fields"

/**
 * SSH key library: metadata in the renderer store, secret text only in the OS
 * keyring (written straight through the native bridge, never to storage).
 */
export default function SshKeys({
  keyTextCache,
  onKeyText,
}: {
  keyTextCache: Map<string, string>
  onKeyText: (keyId: string, text: string | null) => void
}) {
  const store = useStore()
  const [newKeyName, setNewKeyName] = useState("")
  const [keyText, setKeyText] = useState("")
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [rename, setRename] = useState("")
  const [hasSecret, setHasSecret] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const out: Record<string, boolean> = {}
      for (const k of store.keys) {
        try {
          out[k.id] = await nativeBridge.hasKeySecret(k.id)
        } catch {
          out[k.id] = false
        }
      }
      if (live) setHasSecret(out)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.keys.length])

  const saveKeyText = async (id: string) => {
    if (!keyText.trim()) return
    setBusy(id)
    try {
      await nativeBridge.saveKeySecret(id, keyText)
      onKeyText(id, keyText)
      setKeyText("")
      setHasSecret((h) => ({ ...h, [id]: true }))
    } finally {
      setBusy(null)
      setKeyText("")
    }
  }

  return (
    <section>
      <p className="mt-1 text-[12px] text-dim">
        Key text is stored in the OS keyring only — never in the app’s
        storage. Removing a key also wipes its secret natively.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {store.keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-[12px] text-dim">
            No keys yet.
          </p>
        ) : (
          store.keys.map((k) => (
            <div
              key={k.id}
              className="rounded-xl border border-white/[0.08] bg-black/40 p-3"
            >
              <div className="flex items-center gap-2">
                {editingKey === k.id ? (
                  <>
                    <input
                      value={rename}
                      onChange={(e) => setRename(e.target.value)}
                      className={inputClass}
                      aria-label="Key name"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        renameKey(k.id, rename)
                        setEditingKey(null)
                      }}
                      className="shrink-0 rounded-full bg-white/[0.08] px-3 py-1.5 text-[12px] text-fg"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                      {k.name}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-faint">
                      {hasSecret[k.id] ? "● stored" : "○ no secret"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingKey(k.id)
                        setRename(k.name)
                      }}
                      className="shrink-0 rounded-full px-2 py-1 font-mono text-xs text-dim hover:bg-white/[0.07] hover:text-fg"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void nativeBridge
                          .forgetKeySecret(k.id)
                          .catch(() => {})
                          .finally(() => {
                            onKeyText(k.id, null)
                            removeKey(k.id)
                          })
                      }}
                      className="shrink-0 rounded-full px-2 py-1 font-mono text-xs text-[#ff8080] hover:bg-white/[0.07]"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={editingKey === k.id || keyTextCache.has(k.id) ? keyText : ""}
                  onChange={(e) => setKeyText(e.target.value)}
                  onFocus={() => setEditingKey(k.id)}
                  placeholder={
                    hasSecret[k.id]
                      ? "Secret stored — paste to replace"
                      : "Paste private key text (goes to OS keyring)"
                  }
                  aria-label={`Key text for ${k.name}`}
                  className={`${inputClass} font-mono`}
                />
                <button
                  type="button"
                  disabled={busy === k.id || !keyText.trim()}
                  onClick={() => void saveKeyText(k.id)}
                  className="shrink-0 rounded-full bg-white/[0.08] px-3 py-1.5 text-[12px] text-fg disabled:opacity-40"
                >
                  {busy === k.id ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          placeholder="New key name"
          aria-label="New key name"
          className={inputClass}
        />
        <button
          type="button"
          onClick={() => {
            if (!newKeyName.trim()) return
            addKey(newKeyName)
            setNewKeyName("")
          }}
          className="shrink-0 rounded-full bg-white/[0.08] px-4 py-2 text-[13px] text-fg"
        >
          Add
        </button>
      </div>
    </section>
  )
}
