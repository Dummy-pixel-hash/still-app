import type { AgentLibrarySyncStatus } from "../session/agentThreads"
import type { LegacyAgentRecord } from "../agents/types"
import "../styles/agent-library-sync.css"

/** Older records that could not be imported are a historical limitation, not a conversation error. */
export function LegacyRecordsDisclosure({ records }: { records: LegacyAgentRecord[] }) {
  return <details className="agent-library-sync-details">
    <summary>{records.length} older {records.length === 1 ? "record was" : "records were"} not imported</summary>
    <div className="agent-library-sync-records" role="region" aria-label="Older record details" tabIndex={0}>
      <p>These older files do not identify their conversation, project or provider well enough to import safely. They are unchanged on the server and do not block your synced conversations.</p>
      <ul>{records.map(record => <li key={record.executionId}><strong>{record.executionId}</strong><span>{record.reason}</span></li>)}</ul>
    </div>
  </details>
}

/** Mobile sync status. Desktop shows the same facts in the top notice bar and in Agent settings. No red. */
export default function AgentLibrarySyncNotice({ status, compact = false }: { status: AgentLibrarySyncStatus | null; compact?: boolean }) {
  if (!status || compact && !status.failed && !status.warnings.length && !status.legacyRecords.length) return null
  return <div className={`agent-library-sync-notice${compact ? " is-compact" : ""}${status.failed ? " is-error" : ""}`}>
    {(!compact || status.failed || status.warnings.length > 0) && <p role={status.failed ? "alert" : "status"}>{status.failed && <span className="agent-library-sync-dot" aria-hidden="true" />}{status.message}</p>}
    {status.legacyRecords.length > 0 && <LegacyRecordsDisclosure records={status.legacyRecords} />}
    {status.warnings.length > 0 && <details className="agent-library-sync-details">
      <summary>{status.warnings.length} {status.warnings.length === 1 ? "record needs" : "records need"} review</summary>
      <div className="agent-library-sync-records" role="region" aria-label="Sync warning details" tabIndex={0}>
        <ul>{status.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </div>
    </details>}
  </div>
}
