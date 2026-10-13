import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { nativeBridge, type SmartConfig } from "../bridge/nativeBridge"
import { connectionState, nativeSessionId } from "../session/connections"
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
 * Smart orb (experimental): BYO local decision-model endpoint. The toggle is
 * OFF unless the user opts in; the endpoint must be loopback (enforced in
 * Rust, refused otherwise). Copy-paste setup + a Test button so users can
 * verify their server before relying on it.
 */
function SmartOrbSection() {
  const [cfg, setCfg] = useState<SmartConfig | null>(null)
  const [endpointDraft, setEndpointDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [probeOut, setProbeOut] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void nativeBridge
      .smartStatus()
      .then((s) => {
        if (!live) return
        setCfg(s)
        setEndpointDraft(s.endpoint)
      })
      .catch(() => {
        if (live) setCfg({ enabled: false, endpoint: "http://127.0.0.1:8080", cutoff: 0.55 })
      })
    return () => {
      live = false
    }
  }, [])

  const save = async (patch: Partial<SmartConfig>) => {
    setBusy(true)
    setMsg(null)
    try {
      const next = await nativeBridge.smartSet(patch)
      setCfg(next)
      setEndpointDraft(next.endpoint)
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof Error ? e.message.slice(0, 220) : "Could not save smart-orb settings.",
      })
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setProbeOut(null)
    try {
      // Representative ambiguous pane: spinner-ish but no agent chrome.
      const sample = "⠋ thinking…\nreading files…\n(esc to interrupt)"
      const res = await nativeBridge.smartProbe(
        sample,
        endpointDraft.trim() || undefined,
        cfg?.cutoff,
      )
      setProbeOut(
        res.accepted
          ? `Server answered: ${res.verdict} (${Math.round(res.confidence * 100)}% confident) — verdict would be used.`
          : "Server answered but below your cutoff (or unreachable) — the keyword scrape stays in charge.",
      )
    } catch (e) {
      setProbeOut(e instanceof Error ? e.message.slice(0, 220) : "Probe failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">Smart orb</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          experimental · opt-in
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-dim">
        A tiny local decision model (e.g. Julia-1) classifies panes when the
        keyword scrape is unsure. Runs on <span className="font-mono">your</span> machine
        only — pane text goes to localhost, never the cloud. Still ships no
        model; point it at a server you already run.
      </p>
      <label className="mt-2 flex items-center gap-2 text-[13px] text-dim">
        <input
          type="checkbox"
          checked={cfg?.enabled ?? false}
          disabled={!cfg || busy}
          onChange={(e) => void save({ enabled: e.target.checked })}
          className="accent-[#ff4a4a]"
        />
        Use my local model when unsure
      </label>
      <label className="mt-2 block">
        <span className="mb-1 block text-[12px] text-dim">Model endpoint (localhost only)</span>
        <input
          value={endpointDraft}
          onChange={(e) => setEndpointDraft(e.target.value)}
          onBlur={() => {
            if (cfg && endpointDraft.trim() && endpointDraft.trim() !== cfg.endpoint) {
              void save({ endpoint: endpointDraft.trim() })
            }
          }}
          placeholder="http://127.0.0.1:8080"
          spellCheck={false}
          className={`${inputClass} font-mono`}
          aria-label="Smart orb endpoint"
        />
      </label>
      <label className="mt-2 block">
        <span className="mb-1 block text-[12px] text-dim">
          Confidence cutoff — use the model at or above {Math.round((cfg?.cutoff ?? 0.55) * 100)}%
        </span>
        <input
          type="range"
          min={0.3}
          max={0.95}
          step={0.05}
          value={cfg?.cutoff ?? 0.55}
          disabled={!cfg || busy}
          onChange={(e) => void save({ cutoff: Number(e.target.value) })}
          className="w-full accent-[#ff4a4a]"
          aria-label="Smart orb confidence cutoff"
        />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void test()}
          className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-fg transition hover:bg-white/10 disabled:opacity-40"
        >
          {busy ? "Testing…" : "Test my server"}
        </button>
        {probeOut && <p className="text-[12px] text-dim">{probeOut}</p>}
      </div>
      {msg && (
        <p className={`mt-2 text-[12px] ${msg.ok ? "text-[#91b587]" : "text-[#ff6b6b]"}`}>
          {msg.text}
        </p>
      )}
      <details className="mt-2 text-[12px] text-dim">
        <summary className="cursor-pointer text-fg">Setup: run Julia-1 locally</summary>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          <li>
            Install <span className="font-mono">llama-server</span> (any recent
            build with <span className="font-mono">/v1/systemone</span> support).
          </li>
          <li className="break-all">
            <span className="font-mono">
              llama-server -hf ggml-org/Julia-1-GGUF --port 8080
            </span>
          </li>
          <li>Paste the address above, press Test, then flip the toggle on.</li>
        </ol>
      </details>
    </div>
  )
}

/**
 * Live miniature-terminal preview. Reads the same prefs the real xterm
 * surface uses (font size + cursor style + theme colors), so every tweak
 * above reflects here instantly.
 */
function TerminalPreview({
  fontSize,
  cursorStyle,
}: {
  fontSize: number
  cursorStyle: "block" | "underline" | "bar"
}) {
  return (
    <div
      role="img"
      aria-label={`Terminal preview, ${fontSize}px ${cursorStyle} cursor`}
      className="mt-3 overflow-hidden rounded-xl border border-white/[0.07] bg-[#08080a] px-4 py-3"
    >
      <div
        className="font-mono leading-[1.5] text-[#ded9dd]"
        style={{ fontSize: `${fontSize}px` }}
      >
        <div className="truncate">
          <span className="text-[#ff5a5a]">deploy</span>
          <span className="text-[#777078]">@prod-fra-02</span>{" "}
          <span className="text-[#9a96b8]">~</span>
        </div>
        <div className="flex items-center gap-0 truncate">
          <span className="shrink-0 text-[#91b587]">$&nbsp;</span>
          <span className="truncate">nvim main.rs</span>
          {cursorStyle === "block" ? (
            <span className="cursor-blink ml-0.5 inline-block h-[1em] w-[0.6em] shrink-0 bg-[#ff5a5a]" />
          ) : cursorStyle === "underline" ? (
            <span className="cursor-blink ml-0.5 inline-block h-[1em] w-[0.6em] shrink-0 border-b-2 border-[#ff5a5a]" />
          ) : (
            <span className="cursor-blink ml-0.5 inline-block h-[1em] w-[2px] shrink-0 bg-[#ff5a5a]" />
          )}
        </div>
      </div>
    </div>
  )
}

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
  // Orb hook installer state (session picker + one-shot result message).
  const [hookSession, setHookSession] = useState("")
  const [hookBusy, setHookBusy] = useState(false)
  const [hookMsg, setHookMsg] = useState<{ ok: boolean; text: string } | null>(null)

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

  // Live sessions = install targets (a hook install needs a live worker).
  const liveSessions = store.sessions.filter(
    (s) => connectionState(s.id) === "connected",
  )

  const installHooks = async () => {
    const localId = hookSession
    if (!localId) return
    const nativeId = nativeSessionId(localId)
    if (!nativeId) {
      setHookMsg({ ok: false, text: "That session isn't connected right now — connect first, then install." })
      return
    }
    setHookBusy(true)
    setHookMsg(null)
    try {
      const res = await nativeBridge.hooksInstall(nativeId, "claude")
      setHookMsg(
        res.status === "installed"
          ? { ok: true, text: "Hooks installed on the remote host — the orb will now show this agent's own status." }
          : { ok: true, text: "Stamp script installed. No python3 on that host, so merge ~/.still/hooks/claude-hooks.json into ~/.claude/settings.json by hand." },
      )
    } catch (e) {
      setHookMsg({
        ok: false,
        text: e instanceof Error ? e.message.slice(0, 220) : "Install failed — is the session still connected?",
      })
    } finally {
      setHookBusy(false)
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
          <p className="mb-1 mt-3 block font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
            Preview
          </p>
          <TerminalPreview
            fontSize={store.settings.terminal.fontSize}
            cursorStyle={store.settings.terminal.cursorStyle}
          />
        </section>

        <section className="mt-6">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
            Images
          </h3>
          <label className="mt-2 block">
            <span className="mb-1 block text-[12px] text-dim">Insert uploaded image as</span>
            <select
              value={store.settings.imageInsertStyle ?? "path"}
              onChange={(e) =>
                updateSettings({ imageInsertStyle: e.target.value as "path" | "at" })
              }
              className={inputClass}
              aria-label="Image insert style"
            >
              <option value="path" className="bg-[#121214]">File path — Claude, Codex, Pi</option>
              <option value="at" className="bg-[#121214]">@path — OpenCode</option>
            </select>
          </label>
          <p className="mt-1 text-[12px] text-dim">
            After pasting an image, “Insert into agent” types its location
            into the agent’s input. Claude Code, Codex and Pi attach plain
            paths; OpenCode prefers @path.
          </p>
        </section>

        <section className="mt-6">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
            Orb companion
          </h3>
          <label className="mt-2 flex items-center gap-2 text-[13px] text-dim">
            <input
              type="checkbox"
              checked={store.settings.orb?.enabled ?? true}
              onChange={(e) =>
                updateSettings({ orb: { ...(store.settings.orb ?? { minimizeBehavior: "orb" as const }), enabled: e.target.checked } })
              }
              className="accent-[#ff4a4a]"
            />
            Minimize to the floating orb
          </label>
          <label className="mt-2 block">
            <span className="mb-1 block text-[12px] text-dim">Minimize button does</span>
            <select
              value={store.settings.orb?.minimizeBehavior ?? "orb"}
              onChange={(e) =>
                updateSettings({ orb: { ...(store.settings.orb ?? { enabled: true }), minimizeBehavior: e.target.value as "orb" | "taskbar" } })
              }
              className={inputClass}
              aria-label="Minimize button behavior"
            >
              <option value="orb" className="bg-[#121214]">Float the orb (Ctrl+Shift+M)</option>
              <option value="taskbar" className="bg-[#121214]">Plain taskbar minimize</option>
            </select>
          </label>
          <p className="mt-1 text-[12px] text-dim">
            The orb stays on top while the window is tucked away, shows live
            agent statuses on hover, and restores with one click.
          </p>

          {/* Smart orb (experimental, opt-in): a local decision model on YOUR
              machine classifies panes when the keyword scrape is unsure. BYO
              endpoint only in v1 — Still never downloads or ships a model. */}
          <SmartOrbSection />

          {/* Precise agent state (opt-in): installs Still's stamp script on
              the selected session's remote host so Claude Code announces its
              own transitions. Everything else keeps the zero-config scrape. */}
          <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/30 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium text-fg">
                Precise agent state
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                claude · opt-in
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-dim">
              Installs a tiny stamp script + hook entries in the remote
              <span className="font-mono"> ~/.claude/settings.json</span> (backed
              up once). The agent then reports working → done → needs-input
              itself instead of being guessed from the screen.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <select
                value={hookSession}
                onChange={(e) => {
                  setHookSession(e.target.value)
                  setHookMsg(null)
                }}
                className={`${inputClass} flex-1`}
                aria-label="Session whose remote host gets the hooks"
              >
                <option value="" className="bg-[#121214]">Pick a live session…</option>
                {liveSessions.map((s) => (
                  <option key={s.id} value={s.id} className="bg-[#121214]">
                    {s.name} — {s.host}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!hookSession || hookBusy}
                onClick={() => void installHooks()}
                className="shrink-0 rounded-lg border border-[#ff4a4a]/40 bg-[#ff4a4a]/10 px-3 py-2 text-[13px] text-fg transition hover:bg-[#ff4a4a]/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {hookBusy ? "Installing…" : "Install hooks"}
              </button>
            </div>
            {hookMsg && (
              <p className={`mt-2 text-[12px] ${hookMsg.ok ? "text-[#91b587]" : "text-[#ff6b6b]"}`}>
                {hookMsg.text}
              </p>
            )}
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
