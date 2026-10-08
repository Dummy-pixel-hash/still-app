import { useMemo, useState } from "react"
import type { Project, SessionDraft } from "../types"
import { loadPresets, presetDetail, type SessionPreset } from "../session/presets"

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

const STEPS = ["Preset", "Name", "Server", "Login", "Project"] as const

/** True when every char of `query` appears in `target` in order. */
function subseq(query: string, target: string): boolean {
  let i = 0
  for (const c of target) {
    if (c === query[i]) {
      i += 1
      if (i >= query.length) return true
    }
  }
  return i >= query.length
}

/**
 * Rank a preset against a typed query. Higher is better, -1 is no match.
 * Name matches outrank host/user matches; prefix outranks substring;
 * a loose in-order (fuzzy) match still counts so abbreviations work.
 */
export function scorePreset(p: SessionPreset, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const name = p.name.toLowerCase()
  const host = p.host.toLowerCase()
  const user = p.username.toLowerCase()
  if (name.startsWith(q)) return 4
  if (name.includes(q)) return 3
  if (host.startsWith(q) || user.startsWith(q)) return 2
  if (host.includes(q) || user.includes(q)) return 1
  if (subseq(q, name.replace(/\s+/g, ""))) return 0.5
  return -1
}

function portError(port: string): string | null {
  const n = Number.parseInt(port, 10)
  if (!port.trim() || Number.isNaN(n) || n < 1 || n > 65535)
    return "Port must be 1–65535"
  return null
}

/**
 * Stepped new-session flow. One small section per screen — preset search
 * first, then name, server, login, project — each drifting in with an
 * overshoot settle. Authentication is never asked here; it happens at
 * connect time via AuthDialog.
 */
export default function NewSessionWizard({
  initialProjectId,
  projects,
  onCreateProject,
  onSubmit,
  onCancel,
}: {
  initialProjectId: string
  projects: Project[]
  onCreateProject: (name: string) => Project
  onSubmit: (draft: SessionDraft) => void
  onCancel: () => void
}) {
  const [step, setStep] = useState(0)
  const [dir, setDir] = useState<1 | -1>(1)
  const [query, setQuery] = useState("")
  const [presets] = useState<SessionPreset[]>(() => loadPresets())
  // Preset fast-path: a chosen preset fills everything, so the flow skips
  // server/login/project and asks only for a name.
  const [fromPreset, setFromPreset] = useState(false)
  const [appliedName, setAppliedName] = useState("")
  const [name, setName] = useState("")
  const [host, setHost] = useState("")
  const [port, setPort] = useState("22")
  const [username, setUsername] = useState("")
  const [workingDirectory, setWorkingDirectory] = useState("~")
  const [projectId, setProjectId] = useState(initialProjectId)
  const [newProjectName, setNewProjectName] = useState("")
  const [showNewProject, setShowNewProject] = useState(projects.length === 0)
  const [tried, setTried] = useState(false)

  const matches = useMemo(() => {
    const ranked = presets
      .map((p) => ({ p, score: scorePreset(p, query) }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    return ranked.map((r) => r.p)
  }, [presets, query])
  const noMatch = query.trim().length > 0 && matches.length === 0

  const go = (next: number, direction: 1 | -1) => {
    setDir(direction)
    setStep(next)
  }

  const applyPreset = (preset: SessionPreset, advance = true) => {
    setName(preset.name)
    setHost(preset.host)
    setPort(preset.port)
    setUsername(preset.username)
    setWorkingDirectory(preset.workingDirectory)
    setFromPreset(true)
    setAppliedName(preset.name)
    if (advance) go(1, 1)
  }

  const presetEnter = () => {
    if (matches.length > 0) applyPreset(matches[0])
    else if (query.trim()) {
      setName(query.trim())
      setQuery("")
      setFromPreset(false)
      go(2, 1)
    }
  }

  /** Project to file the session under (guards stale ids). */
  const resolveProjectId = (): string => {
    if (projects.some((p) => p.id === projectId)) return projectId
    if (projects.some((p) => p.id === initialProjectId)) return initialProjectId
    return projects[0]?.id ?? ""
  }

  /** Preset fast-path submit: name only, project stays where we started. */
  const finishFromPreset = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setTried(true)
      return
    }
    // A blank preset (e.g. "Custom") has nothing filled — fall through to
    // the full flow instead of creating a hostless session.
    if (!host.trim() || portError(port)) {
      setFromPreset(false)
      go(2, 1)
      return
    }
    const pid = resolveProjectId() || onCreateProject("Default").id
    onSubmit({
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      projectId: pid,
      workingDirectory: workingDirectory.trim() || "~",
      authMethod: "ask",
      keyId: "",
      remember: false,
    })
  }

  const nextFrom = (from: number) => {
    setTried(true)
    if (from === 1 && !name.trim()) return
    if (from === 2) {
      if (!host.trim() || portError(port)) return
    }
    if (from === 3 && !username.trim()) return
    setTried(false)
    go(from + 1, 1)
  }

  const finish = (e: React.FormEvent) => {
    e.preventDefault()
    let pid = resolveProjectId()
    if (projects.length === 0 || showNewProject) {
      const label = newProjectName.trim()
      if (!label && projects.length === 0) return
      if (label) {
        pid = onCreateProject(label).id
      } else if (!pid) {
        return
      }
    }
    if (!pid) return
    onSubmit({
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      projectId: pid,
      workingDirectory: workingDirectory.trim() || "~",
      authMethod: "ask",
      keyId: "",
      remember: false,
    })
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-3xl text-fg">New session</h2>
        <span className="font-mono text-[11px] text-faint">
          {step + 1} / {STEPS.length} · {STEPS[step]}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-1.5" aria-hidden>
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= step ? "bg-[#ff4a4a]/70" : "bg-white/10"
            }`}
          />
        ))}
      </div>

      <div key={step} className={dir >= 0 ? "step-next" : "step-back"}>
        {step === 0 ? (
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              presetEnter()
            }}
          >
            <Field label="Find a preset">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type a name — e.g. Prod FRA"
                aria-label="Search presets"
                spellCheck={false}
                className={`${inputClass} font-mono`}
              />
            </Field>
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto scroll-quiet">
              {matches.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  title={presetDetail(p)}
                  className="group flex items-baseline justify-between gap-3 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-left transition hover:border-[#ff4a4a]/50"
                >
                  <span className="truncate text-[13px] text-fg">{p.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-faint group-hover:text-dim">
                    {p.host ? `${p.username ? `${p.username}@` : ""}${p.host}:${p.port}` : "blank"}
                  </span>
                </button>
              ))}
              {noMatch ? (
                <button
                  type="button"
                  onClick={presetEnter}
                  className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-left text-[13px] text-dim transition hover:border-white/25 hover:text-fg"
                >
                  No preset matches “{query.trim()}” — continue with it as a
                  new connection →
                </button>
              ) : null}
            </div>
            <div className="mt-1 flex items-center justify-between">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setQuery("")
                  setFromPreset(false)
                  go(1, 1)
                }}
                className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
              >
                Skip — start blank →
              </button>
            </div>
          </form>
        ) : null}

        {step === 1 ? (
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (fromPreset) finishFromPreset(e)
              else nextFrom(1)
            }}
          >
            <Field label="Name" error={tried && !name.trim() ? "Name is required" : undefined}>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Prod shell"
                aria-label="Session name"
                className={inputClass}
              />
            </Field>
            <p className="font-mono text-[11px] leading-relaxed text-faint">
              {fromPreset && appliedName
                ? `Preset “${appliedName}” applied — just name it and you’re in.`
                : "What you’ll call this card on the workspace."}
            </p>
            {fromPreset ? (
              <div className="mt-1 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => go(0, -1)}
                  className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  className="rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
                >
                  Create & connect
                </button>
              </div>
            ) : (
              <WizardFooter onBack={() => go(0, -1)} nextLabel="Continue →" />
            )}
          </form>
        ) : null}

        {step === 2 ? (
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              nextFrom(2)
            }}
          >
            <div className="grid grid-cols-[1fr_110px] gap-3">
              <Field label="Host" error={tried && !host.trim() ? "Host is required" : undefined}>
                <input
                  autoFocus
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="dev-fra-02  ·  192.0.2.10"
                  aria-label="Host"
                  spellCheck={false}
                  className={`${inputClass} font-mono`}
                />
              </Field>
              <Field label="Port" error={tried ? (portError(port) ?? undefined) : undefined}>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="22"
                  aria-label="Port"
                  inputMode="numeric"
                  className={`${inputClass} font-mono`}
                />
              </Field>
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-faint">
              The SSH server this session attaches to.
            </p>
            <WizardFooter onBack={() => go(1, -1)} nextLabel="Continue →" />
          </form>
        ) : null}

        {step === 3 ? (
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              nextFrom(3)
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Username" error={tried && !username.trim() ? "Username is required" : undefined}>
                <input
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="deploy"
                  aria-label="Username"
                  spellCheck={false}
                  className={`${inputClass} font-mono`}
                />
              </Field>
              <Field label="Working directory">
                <input
                  value={workingDirectory}
                  onChange={(e) => setWorkingDirectory(e.target.value)}
                  placeholder="~"
                  aria-label="Working directory"
                  spellCheck={false}
                  className={`${inputClass} font-mono`}
                />
              </Field>
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-faint">
              You’ll sign in after connecting — nothing secret lives here.
            </p>
            <WizardFooter onBack={() => go(2, -1)} nextLabel="Continue →" />
          </form>
        ) : null}

        {step === 4 ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={finish}>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
              Project
            </span>
            {projects.length > 0 && !showNewProject ? (
              <div className="flex flex-col gap-1.5">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProjectId(p.id)}
                    aria-pressed={resolveProjectId() === p.id}
                    className={`flex items-baseline justify-between gap-3 rounded-lg border px-3 py-2 text-left transition ${
                      resolveProjectId() === p.id
                        ? "border-[#ff4a4a]/60 bg-[#ff4a4a]/[0.08]"
                        : "border-white/10 bg-black/40 hover:border-white/20"
                    }`}
                  >
                    <span className="truncate text-[13px] text-fg">{p.name}</span>
                    {p.note ? (
                      <span className="shrink-0 font-mono text-[11px] text-faint">
                        {p.note}
                      </span>
                    ) : null}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowNewProject(true)}
                  className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-left text-[13px] text-dim transition hover:border-white/25 hover:text-fg"
                >
                  + New project…
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Project name — e.g. Atlas"
                  aria-label="New project name"
                  spellCheck={false}
                  className={inputClass}
                />
                {projects.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowNewProject(false)}
                    className="shrink-0 rounded-lg px-3 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
                  >
                    Back
                  </button>
                ) : null}
              </div>
            )}
            <div className="mt-1 flex items-center justify-between">
              <button
                type="button"
                onClick={() => go(3, -1)}
                className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
              >
                ← Back
              </button>
              <button
                type="submit"
                className="rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
              >
                Create & connect
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  )
}

function WizardFooter({ onBack, nextLabel }: { onBack: () => void; nextLabel: string }) {
  return (
    <div className="mt-1 flex items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
      >
        ← Back
      </button>
      <button
        type="submit"
        className="rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
      >
        {nextLabel}
      </button>
    </div>
  )
}
