import { useEffect, useState } from "react"
import type { AgentDraftAttachment } from "../agents/attachments"
import { loadAttachmentFile } from "../agents/attachments"
import AgentIcon from "./AgentIcon"

function AttachmentPreview({ attachment }: { attachment: AgentDraftAttachment }) {
  const [url, setUrl] = useState("")
  useEffect(() => {
    let active = true, objectUrl = ""
    void loadAttachmentFile(attachment.id).then(file => {
      if (!active || !file || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"].includes(file.type.toLowerCase())) return
      objectUrl = URL.createObjectURL(file); setUrl(objectUrl)
    }).catch(() => {})
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachment.id])
  return <span className="agent-attachment-preview" aria-hidden="true">{url ? <img src={url} alt="" /> : <AgentIcon name="file" size={15} />}</span>
}

export default function AgentAttachments({ attachments, progress, onRemove }: {
  attachments: AgentDraftAttachment[]
  progress?: Record<string, string>
  onRemove(id: string): void
}) {
  if (!attachments.length) return null
  return <div className="agent-attachments" role="list" aria-label="Message attachments">
    {attachments.map(attachment => <div className="agent-attachment" role="listitem" key={attachment.id}>
      <AttachmentPreview attachment={attachment} />
      <span className="agent-attachment-copy"><strong title={attachment.name}>{attachment.name}</strong><small role={progress?.[attachment.id] ? "status" : undefined}>{progress?.[attachment.id] || `${(attachment.size / 1024).toFixed(0)} KB`}</small></span>
      {progress?.[attachment.id] === "Upload failed" && <span className="agent-attachment-failed" role="status">Retry when sending</span>}
      <button type="button" className="agent-icon-button" aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)}><AgentIcon name="close" size={14} /></button>
    </div>)}
  </div>
}
