/** First-run / no-sessions panel: one primary action and its shortcut hint. */
export default function EmptyState({ hasProjects, onNewSession }: { hasProjects: boolean; onNewSession: () => void }) {
  return (
    <section className="rise mt-10 rounded-[20px] border border-dashed border-white/15 bg-white/[0.02] p-10 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-faint">
        {hasProjects ? "Workspace is empty" : "Welcome to Still"}
      </p>
      <p className="mt-2 font-serif text-3xl text-fg">{hasProjects ? "No sessions yet" : "Connect your first server"}</p>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-dim">
        {hasProjects
          ? "Create your first persistent session. The remote tmux runtime survives disconnects — come back any time and reattach."
          : "Still keeps one persistent tmux session per card. Create a session, connect, and authenticate when asked — reopen any time and reattach."}
      </p>
      <button type="button" onClick={onNewSession} className="mt-5 rounded-full bg-[#e8e2e6] px-5 py-2 text-[13px] font-medium text-[#17171a] transition hover:bg-white">
        New Session
      </button>
      <p className="mt-3 text-xs text-faint">
        Press <kbd className="rounded border border-white/10 px-1 font-mono">Ctrl K</kbd> for the command palette at any time.
      </p>
    </section>
  )
}
