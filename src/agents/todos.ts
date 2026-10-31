import type { AgentTodoItem, AgentTodoSnapshot, AgentTodoSync } from "./types"

export const todoConflictReason = "Showing saved Todos; the remote list does not match."
export const todoStaleReason = "Showing saved Todos; updates may have continued on the server."
const safeInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const printable = (value: unknown, limit: number) => typeof value === "string" && [...value].length <= limit && !/\p{Cc}/u.test(value)
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** The native boundary is authoritative; this also protects legacy caches and test adapters. */
export function normalizeTodos(value: unknown): AgentTodoSnapshot | undefined {
  if (!object(value) || value.protocolVersion !== 3 || !safeInteger(value.revision) || !Array.isArray(value.items) || value.items.length > 100
    || typeof value.available !== "boolean" || typeof value.toolAvailable !== "boolean") return
  const ids = new Set<string>(), items: AgentTodoItem[] = []
  for (const item of value.items) {
    if (!object(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)
      || !printable(item.title, 500) || !String(item.title).trim() || !oneOf(item.status, ["pending", "completed"])
      || !oneOf(item.createdBy, ["user", "agent"]) || !oneOf(item.updatedBy, ["user", "agent"])) return
    if (item.detail !== undefined && !printable(item.detail, 500)) return
    for (const field of ["createdAt", "startedAt", "completedAt", "durationMs"] as const) if (item[field] !== undefined && !safeInteger(item[field])) return
    const next: AgentTodoItem = { id: item.id, title: String(item.title).trim(), status: item.status as AgentTodoItem["status"], createdBy: item.createdBy as AgentTodoItem["createdBy"], updatedBy: item.updatedBy as AgentTodoItem["updatedBy"] }
    for (const field of ["createdAt", "startedAt", "completedAt", "durationMs"] as const) if (item[field] !== undefined) next[field] = item[field] as number
    if (item.detail !== undefined) next.detail = item.detail as string
    ids.add(item.id); items.push(next)
  }
  const activeId = value.activeId
  if (activeId !== undefined && activeId !== null && (typeof activeId !== "string" || !items.some(item => item.id === activeId && item.status === "pending"))) return
  return { protocolVersion: 3, revision: value.revision as number, items, ...(typeof activeId === "string" ? { activeId } : {}), toolAvailable: value.toolAvailable, available: value.available }
}

export function normalizeTodoSync(value: unknown): AgentTodoSync | undefined {
  if (!object(value) || !oneOf(value.state, ["current", "stale", "conflict", "unavailable"])) return
  if (value.reason !== undefined && (!printable(value.reason, 240) || !value.reason)) return
  return { state: value.state as AgentTodoSync["state"], ...(typeof value.reason === "string" ? { reason: value.reason } : {}) }
}

export function todoTaskState(todos: AgentTodoSnapshot) {
  return JSON.stringify([todos.revision, todos.items, todos.activeId ?? null])
}

export function restoreTodos(todos: unknown, sync?: unknown): { todos?: AgentTodoSnapshot; todoSync?: AgentTodoSync } {
  const list = normalizeTodos(todos), observation = normalizeTodoSync(sync)
  if (!list) return { todos: undefined, todoSync: todos ? { state: "unavailable", reason: "The saved Todo list could not be validated." } : observation }
  return {
    todos: list,
    todoSync: observation?.state === "conflict" || observation?.state === "unavailable" ? observation
      : list.available ? { state: "stale", reason: todoStaleReason } : { state: "unavailable", reason: "This execution cannot provide Todo updates. Saved tasks remain readable." },
  }
}

export function reconcileTodos(previous: AgentTodoSnapshot | undefined, previousSync: AgentTodoSync | undefined, incoming: unknown, sync?: unknown, context: { authoritative?: boolean; stale?: boolean } = {}): { todos?: AgentTodoSnapshot; todoSync?: AgentTodoSync; refresh: boolean } {
  const old = normalizeTodos(previous), next = normalizeTodos(incoming), observation = normalizeTodoSync(sync)
  if (!next) return {
    todos: old,
    todoSync: previousSync?.state === "conflict" ? previousSync : incoming == null && observation ? observation : (incoming == null && old
      ? { state: "stale", reason: todoStaleReason } : { state: "unavailable", reason: "Todo updates could not be verified. The last valid list is still shown." }),
    refresh: false,
  }
  const lower = !!old && next.revision < old.revision
  const divergent = !!old && next.revision === old.revision && todoTaskState(old) !== todoTaskState(next)
  if (lower && !context.authoritative && observation?.state !== "conflict") return { todos: previous, todoSync: previousSync, refresh: false }
  if (lower || divergent) return { todos: previous, todoSync: { state: "conflict", reason: todoConflictReason }, refresh: divergent && observation?.state !== "conflict" }
  if (observation?.state === "conflict") return { todos: next, todoSync: observation, refresh: false }
  return {
    todos: next,
    todoSync: observation || (!next.available ? { state: "unavailable", reason: "This execution cannot provide Todo updates. Saved tasks remain readable." }
      : context.stale ? previousSync?.state === "conflict" ? previousSync : { state: "stale", reason: todoStaleReason }
        : { state: "current" }),
    refresh: false,
  }
}
