export interface AgentDraftAttachment {
  id: string
  name: string
  type: string
  size: number
  hostKey: string
  folder: string
  remotePath?: string
}

const databaseName = "still.agent-attachments.v1"
const storeName = "files"
const MAX_FILE_SIZE = 5 * 1024 * 1024
const MAX_TOTAL_SIZE = 20 * 1024 * 1024
const MAX_FILES = 10

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("Could not open local attachment storage."))
  })
}

async function fileTransaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const request = action(tx.objectStore(storeName))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("Could not access local attachment storage."))
    tx.oncomplete = () => db.close()
    tx.onerror = () => { db.close(); reject(tx.error || new Error("Could not save attachment locally.")) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error("Attachment storage was interrupted.")) }
  })
}

export async function saveAttachmentFile(id: string, file: File) { await fileTransaction("readwrite", store => store.put(file, id)) }
export async function loadAttachmentFile(id: string) { return (await fileTransaction("readonly", store => store.get(id))) as File | undefined }
export async function removeAttachmentFile(id: string) { await fileTransaction("readwrite", store => store.delete(id)) }

export function validateAttachments(files: AgentDraftAttachment[], incoming: File[]) {
  if (!incoming.length) return ""
  if (files.length + incoming.length > MAX_FILES) return `Add up to ${MAX_FILES} files to one message.`
  const total = files.reduce((sum, file) => sum + file.size, 0) + incoming.reduce((sum, file) => sum + file.size, 0)
  if (incoming.some(file => !file.size)) return "Empty files can’t be attached."
  if (incoming.some(file => file.size > MAX_FILE_SIZE)) return "Each attachment must be 5 MB or smaller."
  if (total > MAX_TOTAL_SIZE) return "Attachments must total 20 MB or less."
  return ""
}

export function attachmentId() { return crypto.randomUUID() }
export const attachmentLimits = { maxFileSize: MAX_FILE_SIZE, maxTotalSize: MAX_TOTAL_SIZE, maxFiles: MAX_FILES }
