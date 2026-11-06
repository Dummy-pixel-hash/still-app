// Explicit recovery only. Never steal an owner merely because a socket is missing.
import { openSync, closeSync, readSync, readFileSync, writeFileSync, fsyncSync, fstatSync, lstatSync, unlinkSync, constants } from "node:fs"
import { dirname, join } from "node:path"
import { acquireTodoOwner, todoStorePath } from "./todos.mjs"

const executionId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const validPid = value => Number.isSafeInteger(value) && value > 0

export function workerBootId() {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    return /^[a-f0-9-]{36}$/.test(value) ? value : undefined
  } catch { return undefined }
}

function privateJson(file, limit) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > limit) throw new Error("Unsafe recovery record. Inspect the saved execution before resuming.")
    const bytes = Buffer.alloc(limit + 1)
    let length = 0, count
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count
    if (length > limit) throw new Error("The recovery record is too large to verify safely.")
    let value
    try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")) }
    catch { throw new Error("Invalid recovery record. Inspect the saved execution before resuming.") }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery record. Inspect the saved execution before resuming.")
    return { value, stat }
  } finally { closeSync(fd) }
}

function running(pid) {
  if (!validPid(pid)) throw new Error("The previous process identity could not be verified. Inspect the server before resuming.")
  try {
    process.kill(pid, 0)
    // An unreaped child still has a PID but cannot execute any provider work.
    try { if (/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false } catch { /* Retain the conservative live result. */ }
    return true
  }
  catch (error) {
    if (error.code === "ESRCH") return false
    throw new Error("The previous process could not be checked. Inspect the server before resuming.")
  }
}

function sameFile(file, expected) {
  const actual = lstatSync(file)
  return actual.isFile() && !actual.isSymbolicLink() && actual.uid === process.getuid?.() && actual.dev === expected.dev && actual.ino === expected.ino
}

function recoveryIdentity(config) {
  const previous = config.recoverFrom
  if (config.create !== true || !executionId(config.executionId) || !executionId(previous?.executionId) || previous.executionId === config.executionId
    || typeof previous.agentSessionId !== "string" || !previous.agentSessionId || previous.agentSessionId.length > 4096) {
    throw new Error("Invalid saved-execution recovery identity.")
  }
  return previous
}

/** Read-only bootstrap preflight; repeat under the recovery guard before transfer. */
export function verifyExecutionRecovery(directory, config, todoDirectory = dirname(todoStorePath(process.env.HOME, config.conversationId)), recoveryGuard) {
  const previous = recoveryIdentity(config)
  const previousDirectory = join(dirname(directory), previous.executionId)
  for (const path of [previousDirectory, todoDirectory]) {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("The previous execution directory is unsafe. Its ownership was not changed.")
  }
  const guardPath = join(todoDirectory, "recovery.lock")
  let guard
  try { guard = lstatSync(guardPath) } catch (error) { if (error.code !== "ENOENT") throw error }
  if (recoveryGuard ? !guard || !sameFile(guardPath, recoveryGuard) : guard) {
    throw new Error("Another recovery owns this conversation. Inspect its recovery lock before retrying.")
  }
  const { value: state } = privateJson(join(previousDirectory, "state.json"), 16 * 1024 * 1024)
  if (state.executionId !== previous.executionId || state.sessionResult?.sessionId !== previous.agentSessionId
    || state.conversationId !== undefined && state.conversationId !== config.conversationId
    || state.cwd !== undefined && state.cwd !== config.cwd
    || state.agentId !== undefined && state.agentId !== config.agentId
    || !validPid(state.pid) || !validPid(state.childPid)) {
    throw new Error("The previous execution does not match this saved conversation. Its ownership was not changed.")
  }
  const boot = workerBootId()
  const previousBoot = boot && typeof state.bootId === "string" && /^[a-f0-9-]{36}$/.test(state.bootId) && state.bootId !== boot
  if (!previousBoot && (running(state.childPid) || running(state.pid) && !state.ended && !state.closed)) {
    throw new Error("The previous worker or provider process is still running. Reattach or stop it before resuming; no replacement was started.")
  }
  const ownerPath = join(todoDirectory, "owner.lock")
  let owner
  try { owner = privateJson(ownerPath, 1024) }
  catch (error) { if (error.code !== "ENOENT") throw error }
  if (owner && (owner.value.executionId !== previous.executionId || owner.value.pid !== state.pid || !sameFile(ownerPath, owner.stat))) {
    throw new Error("Another execution owns this conversation's Todos. Its ownership was not changed.")
  }
  return { owner, ownerPath }
}

export function recoverExecutionOwner(directory, todoDirectory, config) {
  recoveryIdentity(config)
  // Serialize upgraded recoveries through owner replacement. An interrupted or
  // ambiguous guard is deliberately left for inspection, never automatically reaped.
  const guardPath = join(todoDirectory, "recovery.lock")
  let guard
  try { guard = openSync(guardPath, "wx", 0o600) }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Another recovery owns this conversation. Inspect its recovery lock before retrying.")
    throw error
  }
  const guardStat = fstatSync(guard)
  try {
    writeFileSync(guard, JSON.stringify({ executionId: config.executionId, pid: process.pid }))
    fsyncSync(guard)
    const { owner, ownerPath } = verifyExecutionRecovery(directory, config, todoDirectory, guardStat)
    if (owner) unlinkSync(ownerPath)
    return acquireTodoOwner(todoDirectory, config.executionId)
  } finally {
    closeSync(guard)
    try { if (sameFile(guardPath, guardStat)) unlinkSync(guardPath) } catch { /* Never remove a replaced guard. */ }
  }
}
