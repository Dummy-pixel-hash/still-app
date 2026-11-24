import NewSessionWizard from "../components/NewSessionWizard"
import NewProjectDialog from "../components/NewProjectDialog"
import RemoveProjectDialog from "../components/RemoveProjectDialog"
import RemoveDialog from "../components/RemoveDialog"
import SessionForm from "../components/SessionForm"
import { createProject, removeProject, updateSession } from "../session/store"
import { releaseSession } from "../session/connections"
import type { KeyEntry, Project, Session, SessionDraft } from "../types"

/** The workspace's modal dialogs: new/edit session, remove, new/remove project. */
export default function WorkspaceDialogs({
  projects,
  sessions,
  keys,
  showNew,
  setShowNew,
  showNewProject,
  setShowNewProject,
  editing,
  setEditing,
  removing,
  setRemoving,
  removingProject,
  setRemovingProject,
  onCreate,
}: {
  projects: Project[]
  sessions: Session[]
  keys: KeyEntry[]
  showNew: string | null
  setShowNew: (id: string | null) => void
  showNewProject: boolean
  setShowNewProject: (v: boolean) => void
  editing: Session | null
  setEditing: (s: Session | null) => void
  removing: Session | null
  setRemoving: (s: Session | null) => void
  removingProject: Project | null
  setRemovingProject: (p: Project | null) => void
  onCreate: (draft: SessionDraft) => void
}) {
  const shell = "grain relative max-h-[92vh] w-full max-w-xl overflow-y-auto scroll-quiet rounded-t-[20px] border border-white/10 bg-[#0b0b0e] p-6 sm:rounded-[20px]"
  const scrim = "fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
  return (
    <>
      {showNew ? (
        <div className={scrim} role="dialog" aria-modal="true" aria-label="New session" onClick={() => setShowNew(null)}>
          <div className={shell} onClick={(e) => e.stopPropagation()}>
            <NewSessionWizard
              key={showNew}
              initialProjectId={showNew}
              projects={projects}
              onCreateProject={(name) => createProject(name)}
              onSubmit={(draft) => void onCreate(draft)}
              onCancel={() => setShowNew(null)}
            />
          </div>
        </div>
      ) : null}

      {showNewProject ? <NewProjectDialog onClose={() => setShowNewProject(false)} /> : null}

      {editing ? (
        <div className={scrim} role="dialog" aria-modal="true" aria-label={`Edit ${editing.name}`} onClick={() => setEditing(null)}>
          <div className={shell} onClick={(e) => e.stopPropagation()}>
            <SessionForm
              heading="Edit session"
              submitLabel="Save"
              initial={editing}
              keyOptions={keys}
              onCancel={() => setEditing(null)}
              onSubmit={(draft) => {
                // Metadata only — never auto-connects, tmux identity kept.
                updateSession(editing.id, {
                  name: draft.name.trim(),
                  host: draft.host.trim(),
                  port: Number.parseInt(draft.port, 10) || 22,
                  username: draft.username.trim(),
                  projectId: draft.projectId,
                  workingDirectory: draft.workingDirectory.trim() || "~",
                  authMethod: draft.authMethod,
                  keyId: draft.authMethod === "key" ? draft.keyId || undefined : undefined,
                  remember: draft.remember,
                })
                setEditing(null)
              }}
            />
          </div>
        </div>
      ) : null}

      {removing ? <RemoveDialog session={removing} onClose={() => setRemoving(null)} /> : null}

      {removingProject ? (
        <RemoveProjectDialog
          projectName={removingProject.name}
          sessionCount={sessions.filter((s) => s.projectId === removingProject.id).length}
          onClose={() => setRemovingProject(null)}
          onConfirm={() => {
            const gone = removeProject(removingProject.id)
            setRemovingProject(null)
            // Drop live workers for the removed cards; remote tmux survives.
            void Promise.all(gone.map((s) => releaseSession(s.id)))
          }}
        />
      ) : null}
    </>
  )
}
