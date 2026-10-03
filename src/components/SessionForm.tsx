import { useEffect, useState } from "react"
import {
  KIND_COMMANDS,
  KIND_LABELS,
  blankDraft,
  type Session,
  type SessionDraft,
  type SessionKind,
} from "../types"
import { useStore, validateDraft } from "../session/store"

const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-[13px] text-fg outline-none transition placeholder:text-faint/70 focus:border-[#ff4a4a]/50"

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
        {label}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-[11px] text-[#ff8080]">{error}</span>
      ) : null}
    </label>
  )
}

/**
 * Polished Still session form (new + edit). Validation is field-level and
 * local. Secrets entered here are transient: handed to the connect flow and
 * never written to renderer storage.
 */
export default function SessionForm({
  initial,
  heading,
  submitLabel,
  keyOptions,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<Session>
  heading: string
  submitLabel: string
  keyOptions: { id: string; name: string }[]
  onSubmit: (draft: SessionDraft, secret?: string) => void
  onCancel: () => void
}) {
  const store = useStore()
  const [draft, setDraft] = useState<SessionDraft>(() => ({
    ...blankDraft(initial?.projectId ?? store.projects[0]?.id ?? ""),
    name: initial?.name ?? "",
    host: initial?.host ?? "",
    port: String(initial?.port ?? 22),
    username: initial?.username ?? "",
    projectId: initial?.projectId ?? store.projects[0]?.id ?? "",
    workingDirectory: initial?.workingDirectory ?? "~",
    kind: initial?.kind ?? "shell",
    authMethod: initial?.authMethod ?? "ask",
    keyId: initial?.keyId ?? "",
    remember: initial?.remember ?? false,
  }))
  const [secret, setSecret] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [tried, setTried] = useState(false)

  useEffect(() => {
    if (tried) setErrors(validateDraft(draft))
  }, [draft, tried])

  const set = <K extends keyof SessionDraft>(key: K, value: SessionDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const needsSecret =
    draft.authMethod === "password" ||
    (draft.authMethod === "ask" && secret.trim().length === 0)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const errs = validateDraft(draft)
    setErrors(errs)
    setTried(true)
    if (Object.keys(errs).length > 0) return
    onSubmit(draft, secret || undefined)
    setSecret("")
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h2 className="font-serif text-3xl text-fg">{heading}</h2>

      <Field label="Name" error={errors.name}>
        <input
          className={inputClass}
          value={draft.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Prod shell"
          aria-label="Session name"
        />
      </Field>

      <div className="grid grid-cols-[1fr_110px] gap-3">
        <Field label="Host" error={errors.host}>
          <input
            className={`${inputClass} font-mono`}
            value={draft.host}
            onChange={(e) => set("host", e.target.value)}
            placeholder="dev-fra-02  ·  192.0.2.10"
            aria-label="Host"
            spellCheck={false}
          />
        </Field>
        <Field label="Port" error={errors.port}>
          <input
            className={`${inputClass} font-mono`}
            value={draft.port}
            onChange={(e) => set("port", e.target.value)}
            placeholder="22"
            aria-label="Port"
            inputMode="numeric"
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Username" error={errors.username}>
          <input
            className={`${inputClass} font-mono`}
            value={draft.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="deploy"
            aria-label="Username"
            spellCheck={false}
          />
        </Field>
        <Field label="Working directory">
          <input
            className={`${inputClass} font-mono`}
            value={draft.workingDirectory}
            onChange={(e) => set("workingDirectory", e.target.value)}
            placeholder="~"
            aria-label="Working directory"
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Project" error={errors.projectId}>
          <select
            className={inputClass}
            value={draft.projectId}
            onChange={(e) => set("projectId", e.target.value)}
            aria-label="Project"
          >
            {store.projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-[#121214]">
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Session kind">
          <select
            className={inputClass}
            value={draft.kind}
            onChange={(e) => set("kind", e.target.value as SessionKind)}
            aria-label="Session kind"
          >
            {(Object.keys(KIND_LABELS) as SessionKind[]).map((k) => (
              <option key={k} value={k} className="bg-[#121214]">
                {KIND_LABELS[k]} · {KIND_COMMANDS[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset>
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
          Authentication
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["password", "Password"],
              ["key", "SSH key"],
              ["ask", "Ask every time"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={draft.authMethod === value}
              onClick={() => set("authMethod", value)}
              className={`rounded-lg border px-2 py-2 text-[12px] transition ${
                draft.authMethod === value
                  ? "border-[#ff4a4a]/60 bg-[#ff4a4a]/[0.08] text-fg"
                  : "border-white/10 bg-black/40 text-dim hover:border-white/20 hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {draft.authMethod === "password" && (
          <div className="mt-3">
            <input
              type="password"
              autoComplete="new-password"
              className={`${inputClass} font-mono`}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Password — used once to connect, never stored here"
              aria-label="Password"
            />
          </div>
        )}
        {draft.authMethod === "key" && (
          <div className="mt-3">
            {keyOptions.length === 0 ? (
              <p className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-[12px] text-dim">
                No keys yet — add one under Settings → SSH keys, then pick it
                here.
              </p>
            ) : (
              <select
                className={inputClass}
                value={draft.keyId}
                onChange={(e) => set("keyId", e.target.value)}
                aria-label="SSH key"
              >
                <option value="" className="bg-[#121214]">
                  Choose a key…
                </option>
                {keyOptions.map((k) => (
                  <option key={k.id} value={k.id} className="bg-[#121214]">
                    {k.name}
                  </option>
                ))}
              </select>
            )}
            {errors.keyId ? (
              <span className="mt-1 block text-[11px] text-[#ff8080]">
                {errors.keyId}
              </span>
            ) : null}
          </div>
        )}
        {draft.authMethod === "ask" && needsSecret && (
          <p className="mt-2 font-mono text-[11px] text-faint">
            You’ll be asked for a password or key each time you connect.
          </p>
        )}

        <label className="mt-3 flex items-center gap-2 text-[12px] text-dim">
          <input
            type="checkbox"
            checked={draft.remember}
            onChange={(e) => set("remember", e.target.checked)}
            className="accent-[#ff4a4a]"
          />
          Remember on this device <span className="font-mono text-[10px] text-faint">(OS keyring, native only)</span>
        </label>
      </fieldset>

      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
