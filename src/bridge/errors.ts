/** Tauri rejects with serialized StillError objects, not necessarily Error. */
export function nativeErrorMessage(failure: unknown, fallback: string): string {
  if (failure instanceof Error && failure.message.trim()) return failure.message
  if (typeof failure === "string" && failure.trim()) return failure
  if (failure && typeof failure === "object" && "message" in failure && typeof failure.message === "string" && failure.message.trim()) return failure.message
  return fallback
}
