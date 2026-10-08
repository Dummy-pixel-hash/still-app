/** Confirm dialog for deleting a project and its sessions. */
export default function RemoveProjectDialog({
  projectName,
  sessionCount,
  onClose,
  onConfirm,
}: {
  projectName: string
  sessionCount: number
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Remove project ${projectName}`}
      onClick={onClose}
    >
      <div
        className="grain relative max-h-[92vh] w-full max-w-md overflow-y-auto scroll-quiet rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-2xl text-fg">
          Remove “{projectName}”?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-dim">
          {sessionCount === 0
            ? "This project is empty. It will be removed from the workspace."
            : `${sessionCount} session${sessionCount === 1 ? "" : "s"} inside it will be removed too, and disconnected. Remote tmux sessions survive — only the local cards go away.`}
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-[13px] text-dim transition hover:bg-white/[0.06] hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-full bg-[#ff4a4a] px-5 py-2 text-[13px] font-medium text-white transition hover:bg-[#ff6060]"
          >
            Remove project
          </button>
        </div>
      </div>
    </div>
  )
}
