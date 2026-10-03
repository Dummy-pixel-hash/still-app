import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { nativeBridge } from "../bridge/nativeBridge"
import {
  addKey,
  removeKey,
  renameKey,
  updateSettings,
  updateTerminalPrefs,
  useStore,
} from "../session/store"

const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-[13px] text-fg outline-none transition placeholder:text-faint/70 focus:border-[#ff4a4a]/50"

/**
 * Settings sheet: terminal prefs, confirm-remove toggle, key-library entry.
 * Key text is written straight to the OS keyring — never to renderer storage.
 */
export default function SettingsSheet({
  onClose,
  keyTextCache,
  onKeyText,
}: {
  onClose: () => void
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

  // Portalled: workspace gets pointer-events:none while the overlay is open.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div
        className="grain relative max-h-[92vh] w-full max-w-xl overflow-y-auto scroll-quiet rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-3xl text-fg">Settings</h2>

        <section className="mt-5">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
            Terminal
          </h3>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-dim">Font size</span>
              <input
                type="number"
                min={10}
                max={22}
                value={store.settings.terminal.fontSize}
                onChange={(e) =>
                  updateTerminalPrefs({
                    fontSize: Math.min(22, Math.max(10, Number(e.target.value) || 14)),
                  })
                }
                className={inputClass}
                aria-label="Terminal font size"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-dim">Cursor</span>
              <select
                value={store.settings.terminal.cursorStyle}
                onChange={(e) =>
                  updateTerminalPrefs({
                    cursorStyle: e.target.value as "block" | "underline" | "bar",
                  })
                }
                className={inputClass}
                aria-label="Cursor style"
              >
                <option value="block" className="bg-[#121214]">Block</option>
                <option value="underline" className="bg-[#121214]">Underline</option>
                <option value="bar" className="bg-[#121214]">Bar</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-dim">Scrollback</span>
              <input
                type="number"
                min={1000}
                max={50000}
                step={1000}
                value={store.settings.terminal.scrollback}
                onChange={(e) =>
                  updateTerminalPrefs({
                    scrollback: Math.min(
                      50000,
                      Math.max(1000, Number(e.target.value) || 5000),
                    ),
                  })
                }
                className={inputClass}
                aria-label="Scrollback lines"
              />
            </label>
          </div>
        </section>

        <section className="mt-6">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
            Sessions
          </h3>
          <label className="mt-2 flex items-center gap-2 text-[13px] text-dim">
            <input
              type="checkbox"
              checked={store.settings.confirmRemove}
              onChange={(e) => updateSettings({ confirmRemove: e.target.checked })}
              className="accent-[#ff4a4a]"
            />
            Confirm before removing a session
          </label>
        </section>

        <section className="mt-6">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
            SSH keys
          </h3>
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
                        <span className="shrink-0 font-mono text-[10px] text-faint">
                          {hasSecret[k.id] ? "● stored" : "○ no secret"}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingKey(k.id)
                            setRename(k.name)
                          }}
                          className="shrink-0 rounded-full px-2 py-1 font-mono text-[11px] text-dim hover:bg-white/[0.07] hover:text-fg"
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
                          className="shrink-0 rounded-full px-2 py-1 font-mono text-[11px] text-[#ff8080] hover:bg-white/[0.07]"
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

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => {
              onClose()
            }}
            className="rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] hover:bg-white"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
