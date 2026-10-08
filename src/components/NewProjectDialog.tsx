import { useState } from "react"
import { createProject } from "../session/store"

const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-[13px] text-fg outline-none transition placeholder:text-faint/70 focus:border-[#ff4a4a]/50"

/** Small dialog for creating a project from the main screen. */
export default function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("")
  const [note, setNote] = useState("")
  const [tried, setTried] = useState(false)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!name.trim()) return
    createProject(name.trim(), note.trim())
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      onClick={onClose}
    >
      <div
        className="grain relative max-h-[92vh] w-full max-w-md overflow-y-auto scroll-quiet rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <h2 className="font-serif text-3xl text-fg">New project</h2>
            <p className="mt-1 text-[12px] text-dim">
              Group related sessions. Drag cards between projects any time.
            </p>
          </div>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
              Name
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Atlas"
              aria-label="Project name"
              spellCheck={false}
              className={inputClass}
            />
            {tried && !name.trim() ? (
              <span className="mt-1 block text-[11px] text-[#ff8080]">
                Name is required
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
              Note <span className="normal-case tracking-normal">(optional)</span>
            </span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Payments API · production"
              aria-label="Project note"
              spellCheck={false}
              className={`${inputClass} font-mono`}
            />
          </label>
          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white"
            >
              Create project
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
