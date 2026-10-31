import { TextDecoder } from "node:util"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readlink, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export const GIT_STATUS_MAX_BYTES = 2 * 1024 * 1024
export const GIT_STATUS_MAX_ENTRIES = 2000
export const GIT_DIFF_MAX_BYTES = 512 * 1024
export const GIT_DIFF_MAX_LINES = 10_000

const utf8 = new TextDecoder("utf-8", { fatal: true })
const byte = (buffer, value, start = 0) => buffer.indexOf(value, start)
const fail = type => { throw new Error(`Malformed Git ${type} output`) }
const validObjectId = value => /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value)
const validMode = value => /^[0-7]{6}$/.test(value)
const REQUEST_MAX_BYTES = 256 * 1024
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024
const STDERR_MAX_BYTES = 16 * 1024
const FILTER_CONFIG_MAX_BYTES = 64 * 1024
const OPERATION_TIMEOUT_MS = 10_000
const FILTER_PATH_BATCH_BYTES = 64 * 1024

function inputBytes(input, type) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  throw new TypeError(`Git ${type} output must be bytes`)
}

function limits(options = {}) {
  const maxBytes = options.maxBytes ?? GIT_STATUS_MAX_BYTES
  const maxEntries = options.maxEntries ?? GIT_STATUS_MAX_ENTRIES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError("Git parser limits must be non-negative safe integers (maxBytes must be positive)")
  }
  return { maxBytes, maxEntries }
}

function displayPath(pathBytes) {
  let path
  try { path = utf8.decode(pathBytes) } catch {
    return [...pathBytes].map(value => `\\x${value.toString(16).padStart(2, "0").toUpperCase()}`).join("")
  }
  return [...path].map(character => {
    if (!/\p{Cc}/u.test(character)) return character
    const value = character.codePointAt(0)
    return value <= 0xff ? `\\x${value.toString(16).padStart(2, "0").toUpperCase()}` : `\\u{${value.toString(16).toUpperCase()}}`
  }).join("")
}

function pathFields(pathBytes, originalPathBytes) {
  return {
    path: displayPath(pathBytes),
    pathBytesBase64: pathBytes.toString("base64"),
    ...(originalPathBytes ? {
      originalPath: displayPath(originalPathBytes),
      originalPathBytesBase64: originalPathBytes.toString("base64"),
    } : {}),
  }
}

function prefixFields(record, count, type) {
  const fields = []
  let offset = 0
  for (let index = 0; index < count; index++) {
    const separator = byte(record, 0x20, offset)
    if (separator < 0) fail(type)
    fields.push(record.subarray(offset, separator).toString("ascii"))
    offset = separator + 1
  }
  const path = record.subarray(offset)
  if (!path.length) fail(type)
  return { fields, path }
}

function validXY(value, type) {
  if (!/^[.MADRCUT]{2}$/.test(value)) fail(type)
  return value
}

function entryKind({ type, xy, submodule, score }) {
  if (type === "u") return "conflicted"
  if (submodule) return "submodule"
  if (score?.startsWith("R") || xy.includes("R")) return "renamed"
  if (score?.startsWith("C") || xy.includes("C")) return "copied"
  if (xy.includes("T")) return "typeChanged"
  if (xy.includes("D")) return "deleted"
  if (xy.includes("A")) return "added"
  return "modified"
}

function parseStatusRecord(record) {
  if (record.length < 2) fail("status")
  const type = String.fromCharCode(record[0])
  if (record[1] !== 0x20) fail("status")
  if (type === "#") {
    try { return { header: displayPath(record.subarray(2)) } } catch { fail("status") }
  }
  if (type === "!") return { ignored: true }
  if (type === "?") {
    const pathBytes = record.subarray(2)
    if (!pathBytes.length) fail("status")
    return {
      entry: {
        ...pathFields(pathBytes), indexStatus: "?", worktreeStatus: "?", kind: "untracked",
        additions: null, deletions: null, binary: null,
      },
    }
  }

  const fieldCount = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : 0
  if (!fieldCount) fail("status")
  const { fields, path } = prefixFields(record.subarray(2), fieldCount - 1, "status")
  // The record type precedes the fields parsed above.
  const xy = validXY(fields[0], "status")
  const sub = fields[1]
  if (!/^(?:N\.\.\.|S[.C][.M][.U])$/.test(sub)) fail("status")
  const modes = type === "u" ? fields.slice(2, 6) : fields.slice(2, 5)
  const objectIds = type === "u" ? fields.slice(6, 9) : fields.slice(5, 7)
  if (modes.some(mode => !validMode(mode)) || objectIds.some(id => !validObjectId(id))) fail("status")
  let score
  if (type === "2") {
    score = fields[fields.length - 1]
    const similarity = /^[RC]([0-9]{1,3})$/.exec(score)
    if (!similarity || Number(similarity[1]) > 100) fail("status")
  }
  const submodule = sub?.startsWith("S") || fields.slice(2, 5).includes("160000")
  return {
    entry: {
      ...pathFields(path), indexStatus: xy[0], worktreeStatus: xy[1],
      kind: entryKind({ type, xy, submodule, score }),
      additions: null, deletions: null, binary: null,
    },
    rename: type === "2",
  }
}

/** Parses Git's porcelain-v2 `-z` status bytes without decoding stored paths. */
export function parsePorcelainV2(input, options = {}) {
  const source = inputBytes(input, "status")
  const { maxBytes, maxEntries } = limits(options)
  const end = Math.min(source.length, maxBytes)
  const branch = { headOid: null, branch: null, upstream: null, ahead: null, behind: null, detached: false, unborn: false }
  const entries = []
  let offset = 0, truncated = source.length > maxBytes, sawBranchOid = false, sawBranchHead = false

  while (offset < end) {
    const terminator = byte(source, 0, offset)
    if (terminator < 0 || terminator >= end) { truncated = true; break }
    const parsed = parseStatusRecord(source.subarray(offset, terminator))
    offset = terminator + 1
    if (parsed.header !== undefined) {
      const separator = parsed.header.indexOf(" ")
      const key = separator < 0 ? parsed.header : parsed.header.slice(0, separator)
      const value = separator < 0 ? "" : parsed.header.slice(separator + 1)
      if (key === "branch.oid") {
        if (sawBranchOid) fail("status")
        sawBranchOid = true
        if (value === "(initial)") { branch.headOid = null; branch.unborn = true }
        else if (validObjectId(value)) { branch.headOid = value; branch.unborn = false }
        else fail("status")
      } else if (key === "branch.head") {
        if (sawBranchHead) fail("status")
        sawBranchHead = true
        branch.detached = value === "(detached)"
        branch.branch = branch.detached ? null : value || null
      } else if (key === "branch.upstream") branch.upstream = value || null
      else if (key === "branch.ab") {
        const match = /^\+([0-9]+) -([0-9]+)$/.exec(value)
        if (!match) fail("status")
        branch.ahead = Number(match[1]); branch.behind = Number(match[2])
        if (!Number.isSafeInteger(branch.ahead) || !Number.isSafeInteger(branch.behind)) fail("status")
      }
      continue
    }
    if (parsed.ignored) continue
    if (parsed.rename) {
      const originalEnd = byte(source, 0, offset)
      if (originalEnd < 0 || originalEnd >= end) { truncated = true; break }
      const originalPath = source.subarray(offset, originalEnd)
      if (!originalPath.length) fail("status")
      if (entries.length >= maxEntries) { truncated = true; break }
      parsed.entry.originalPath = displayPath(originalPath)
      parsed.entry.originalPathBytesBase64 = originalPath.toString("base64")
      entries.push(parsed.entry)
      offset = originalEnd + 1
    } else {
      if (entries.length >= maxEntries) { truncated = true; break }
      entries.push(parsed.entry)
    }
  }
  if (!truncated && (!sawBranchOid || !sawBranchHead)) fail("status")
  return { branch, entries, truncated }
}

function parseCount(value, type) {
  if (value === "-") return null
  if (!/^[0-9]+$/.test(value)) fail(type)
  const count = Number(value)
  if (!Number.isSafeInteger(count)) fail(type)
  return count
}

/** Parses Git's `diff --numstat -z` bytes, including old/new rename path pairs. */
export function parseNumstatZ(input, options = {}) {
  const source = inputBytes(input, "numstat")
  const { maxBytes, maxEntries } = limits(options)
  const end = Math.min(source.length, maxBytes)
  let offset = 0, truncated = source.length > maxBytes
  const entries = []
  while (offset < end) {
    const terminator = byte(source, 0, offset)
    if (terminator < 0 || terminator >= end) { truncated = true; break }
    const header = source.subarray(offset, terminator)
    const firstTab = byte(header, 0x09), secondTab = firstTab < 0 ? -1 : byte(header, 0x09, firstTab + 1)
    if (firstTab < 0 || secondTab < 0) fail("numstat")
    const additions = parseCount(header.subarray(0, firstTab).toString("ascii"), "numstat")
    const deletions = parseCount(header.subarray(firstTab + 1, secondTab).toString("ascii"), "numstat")
    if ((additions === null) !== (deletions === null)) fail("numstat")
    let path = header.subarray(secondTab + 1)
    let originalPath
    offset = terminator + 1
    if (!path.length) {
      const oldEnd = byte(source, 0, offset)
      if (oldEnd < 0 || oldEnd >= end) { truncated = true; break }
      originalPath = source.subarray(offset, oldEnd)
      const newStart = oldEnd + 1
      const newEnd = byte(source, 0, newStart)
      if (!originalPath.length || newEnd < 0 || newEnd >= end) { truncated = true; break }
      path = source.subarray(newStart, newEnd)
      if (!path.length) { truncated = true; break }
      offset = newEnd + 1
    }
    if (entries.length >= maxEntries) { truncated = true; break }
    entries.push({ ...pathFields(path, originalPath), additions, deletions, binary: additions === null })
  }
  return { entries, truncated }
}

class GitReviewError extends Error {
  constructor(code, message) { super(message); this.name = "GitReviewError"; this.code = code }
}

function safeMessage(value) {
  const clean = String(value || "").replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim()
  return [...clean].slice(0, 500).join("") || "Git inspection failed."
}

function gitFailure(stderr, code) {
  const message = safeMessage(Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr)
  if (/detected dubious ownership|unsafe repository/i.test(message)) return new GitReviewError("wrongOwnership", message)
  if (/not a git repository/i.test(message)) return new GitReviewError("notRepository", message)
  return new GitReviewError("gitCommand", message || `Git exited with status ${code}.`)
}

function cleanGitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C" }
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG_") || key.startsWith("GIT_TRACE") || [
      "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR", "GIT_SUPER_PREFIX", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
      "GIT_EXEC_PATH", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE",
      "GIT_REPLACE_REF_BASE", "GIT_ATTR_SOURCE",
    ].includes(key)) delete env[key]
  }
  return env
}

function killProcessTree(child) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
    else child.kill("SIGKILL")
  } catch {
    try { child.kill("SIGKILL") } catch {}
  }
}

async function beforeDeadline(start, deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new GitReviewError("timeout", "Git inspection exceeded its 10-second deadline.")
  let timer
  try {
    return await Promise.race([
      start(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new GitReviewError("timeout", "Git inspection exceeded its 10-second deadline.")), remaining) }),
    ])
  } finally { clearTimeout(timer) }
}

async function runGit(args, { cwd, deadline, maxStdout = GIT_STATUS_MAX_BYTES, stdin = null, allowedExitCodes = [0] }) {
  if (Date.now() >= deadline) throw new GitReviewError("timeout", "Git inspection exceeded its 10-second deadline.")
  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
    throw new GitReviewError("invalidRequest", "Git inspection contains an invalid argument.")
  }
  if (stdin !== null && (!Buffer.isBuffer(stdin) || stdin.length > GIT_STATUS_MAX_BYTES)) {
    throw new GitReviewError("invalidRequest", "Git inspection input exceeded its byte limit.")
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false, timedOut = false, overflow = false, stderrTruncated = false
    let stdoutBytes = 0, stderrBytes = 0
    const stdout = [], stderr = []
    let child, timer
    const finishReject = error => {
      if (settled) return
      settled = true; clearTimeout(timer); rejectPromise(error)
    }
    const finishResolve = result => {
      if (settled) return
      settled = true; clearTimeout(timer); resolvePromise(result)
    }
    try {
      child = spawn("git", args, {
        cwd, env: cleanGitEnvironment(), stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true, detached: process.platform !== "win32",
      })
    } catch (error) {
      finishReject(new GitReviewError(error?.code === "ENOENT" ? "gitUnavailable" : "gitSpawn", safeMessage(error?.message)))
      return
    }
    const remaining = Math.max(1, deadline - Date.now())
    timer = setTimeout(() => { timedOut = true; killProcessTree(child) }, remaining)
    const retain = (chunks, chunk, limit, isStdout) => {
      const data = Buffer.from(chunk)
      const used = isStdout ? stdoutBytes : stderrBytes
      const keep = Math.max(0, Math.min(data.length, limit - used))
      if (keep) chunks.push(data.subarray(0, keep))
      if (isStdout) {
        stdoutBytes += keep
        if (keep < data.length) { overflow = true; killProcessTree(child) }
      } else {
        stderrBytes += keep
        if (keep < data.length) stderrTruncated = true
      }
    }
    child.stdout.on("data", chunk => retain(stdout, chunk, maxStdout, true))
    child.stderr.on("data", chunk => retain(stderr, chunk, STDERR_MAX_BYTES, false))
    child.stdin.on("error", () => {})
    child.once("error", error => finishReject(new GitReviewError(error?.code === "ENOENT" ? "gitUnavailable" : "gitSpawn", safeMessage(error?.message))))
    child.once("close", (code, signal) => {
      if (settled) return
      if (timedOut) { finishReject(new GitReviewError("timeout", "Git inspection exceeded its 10-second deadline.")); return }
      const output = Buffer.concat(stdout, stdoutBytes), errorOutput = Buffer.concat(stderr, stderrBytes)
      if (!overflow && !allowedExitCodes.includes(code)) { finishReject(gitFailure(errorOutput, code)); return }
      finishResolve({ stdout: output, stderr: errorOutput, code, signal, overflow, stderrTruncated })
    })
    if (stdin) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

function gitArgs(filterOverrides = []) {
  return [
    "--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-c", "core.fsmonitor=false",
    "-c", "core.pager=cat", "-c", "diff.external=", "-c", "status.relativePaths=false",
    "-c", "status.renames=true", "-c", "status.renameLimit=200", "-c", "diff.renameLimit=200",
    ...filterOverrides,
  ]
}

function trimOutputNewline(output, type) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output)
  const end = bytes.length && bytes[bytes.length - 1] === 0x0a ? bytes.subarray(0, bytes.length - 1) : bytes
  try { return utf8.decode(end) } catch { throw new GitReviewError("malformedOutput", `Git returned invalid ${type} bytes.`) }
}

function validateCwd(cwd) {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0") || cwd.length > 4096 || !isAbsolute(cwd)) {
    throw new GitReviewError("invalidRequest", "Git inspection requires an absolute selected directory.")
  }
  return cwd
}

async function resolveRepository(cwd, deadline) {
  let selected
  try { selected = await beforeDeadline(() => realpath(validateCwd(cwd)), deadline) } catch (error) {
    throw new GitReviewError("notRepository", safeMessage(error?.message || "The selected directory is unavailable."))
  }
  const base = gitArgs()
  let bareResult
  try { bareResult = await runGit([...base, "rev-parse", "--is-bare-repository"], { cwd: selected, deadline, maxStdout: 128 }) }
  catch (error) { throw error }
  if (trimOutputNewline(bareResult.stdout, "repository type") === "true") {
    return { state: "notRepository", reason: "Bare repositories cannot be reviewed." }
  }
  const rootOutput = await runGit([...base, "rev-parse", "--show-toplevel"], { cwd: selected, deadline, maxStdout: 16 * 1024 })
  const gitDirOutput = await runGit([...base, "rev-parse", "--absolute-git-dir"], { cwd: selected, deadline, maxStdout: 16 * 1024 })
  const indexOutput = await runGit([...base, "rev-parse", "--git-path", "index"], { cwd: selected, deadline, maxStdout: 16 * 1024 })
  let root, gitDir
  try {
    root = await beforeDeadline(() => realpath(trimOutputNewline(rootOutput.stdout, "worktree root")), deadline)
    gitDir = await beforeDeadline(() => realpath(trimOutputNewline(gitDirOutput.stdout, "Git directory")), deadline)
  } catch (error) { throw new GitReviewError("notRepository", safeMessage(error?.message)) }
  const indexOutputPath = trimOutputNewline(indexOutput.stdout, "index path")
  const indexPath = isAbsolute(indexOutputPath) ? indexOutputPath : resolve(root, indexOutputPath)
  const within = relative(root, selected)
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new GitReviewError("notRepository", "The selected directory is outside the resolved worktree.")
  }
  return { state: "ready", selected, root, gitDir, indexPath }
}

function statSignature(stat, type) {
  return {
    type,
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  }
}

async function lstatSignature(path, deadline) {
  try {
    const stat = await beforeDeadline(() => lstat(path, { bigint: true }), deadline)
    const type = stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other"
    return statSignature(stat, type)
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { type: "missing" }
    throw new GitReviewError("filesystem", safeMessage(error?.message))
  }
}

function sameValue(left, right) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    return value
  }
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function statusFingerprint(repo, identity, statusBytes, statusOverflow, filterFingerprint) {
  return createHash("sha256").update(repo.root).update("\0").update(repo.gitDir).update("\0")
    .update(identity.headOid || "(unborn)").update("\0").update(JSON.stringify(identity.indexSignature)).update("\0")
    .update(filterFingerprint).update("\0")
    .update(statusOverflow ? "truncated\0" : "complete\0").update(statusBytes).digest("hex")
}

function parseConfigRecords(output) {
  const records = []
  let offset = 0
  while (offset < output.length) {
    const end = byte(output, 0, offset)
    if (end < 0) fail("filter configuration")
    const record = output.subarray(offset, end), separator = byte(record, 0x0a)
    if (separator < 0) fail("filter configuration")
    const key = record.subarray(0, separator).toString("ascii")
    let value
    try { value = utf8.decode(record.subarray(separator + 1)) } catch { fail("filter configuration") }
    records.push({ key, value }); offset = end + 1
  }
  return records
}

async function readFilterSettings(root, deadline) {
  const result = await runGit([...gitArgs(), "config", "--null", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], {
    cwd: root, deadline, maxStdout: FILTER_CONFIG_MAX_BYTES, allowedExitCodes: [0, 1],
  })
  if (result.overflow) throw new GitReviewError("filterConfigTooLarge", "Git filter configuration exceeds its safe inspection limit.")
  const records = parseConfigRecords(result.stdout), overrides = [], externalFilters = new Set(), overrideKeys = new Set()
  for (const { key, value } of records) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(key)
    if (!match || match[1].length > 128) throw new GitReviewError("malformedOutput", "Git returned an invalid filter configuration key.")
    const name = match[1], operation = match[2].toLowerCase()
    if (["clean", "smudge", "process"].includes(operation)) {
      overrideKeys.add(key)
      if (value.trim()) externalFilters.add(name)
    }
  }
  for (const key of overrideKeys) overrides.push("-c", `${key}=`)
  for (const name of externalFilters) overrides.push("-c", `filter.${name}.required=false`)
  const fingerprint = createHash("sha256").update(JSON.stringify(records)).digest("hex")
  return { overrides, externalFilters, fingerprint }
}

function decodePath(pathBytesBase64) {
  if (typeof pathBytesBase64 !== "string" || !pathBytesBase64 || pathBytesBase64.length > GIT_STATUS_MAX_BYTES * 2
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pathBytesBase64)) {
    throw new GitReviewError("invalidPath", "Git entry contains invalid path bytes.")
  }
  const bytes = Buffer.from(pathBytesBase64, "base64")
  if (!bytes.length || bytes.includes(0) || bytes.toString("base64") !== pathBytesBase64) {
    throw new GitReviewError("invalidPath", "Git entry contains invalid path bytes.")
  }
  let text
  try { text = utf8.decode(bytes) } catch { return { bytes, text: null } }
  return { bytes, text }
}

function repoRelativePath(root, pathBytesBase64) {
  const decoded = decodePath(pathBytesBase64)
  if (!decoded.text) return { ...decoded, absolute: null }
  const value = decoded.text
  if (isAbsolute(value) || (process.platform === "win32" && value.includes("\\"))) {
    throw new GitReviewError("invalidPath", "Git returned a path outside its worktree.")
  }
  const parts = value.split("/")
  if (parts.some(part => !part || part === "." || part === "..")) throw new GitReviewError("invalidPath", "Git returned a path outside its worktree.")
  const absolute = resolve(root, ...parts), pathFromRoot = relative(root, absolute)
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new GitReviewError("invalidPath", "Git returned a path outside its worktree.")
  }
  return { ...decoded, absolute }
}

async function readLinkLabel(path, deadline) {
  try {
    const target = await beforeDeadline(() => readlink(path, { encoding: "buffer" }), deadline)
    const retained = target.subarray(0, 512)
    return displayPath(retained) + (target.length > retained.length ? "…" : "")
  } catch { return undefined }
}

async function fileInfo(root, pathBytesBase64, deadline) {
  const pathInfo = repoRelativePath(root, pathBytesBase64)
  if (!pathInfo.text) return { type: "unsupportedPath", signature: { type: "unsupportedPath" } }
  const parts = pathInfo.text.split("/")
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    const signature = await lstatSignature(current, deadline)
    if (signature.type === "missing") return { type: "missing", signature }
    if (signature.type === "symlink") {
      return { type: "symlink", signature, linkTarget: await readLinkLabel(current, deadline), symlinkPath: parts.slice(0, index + 1).join("/") }
    }
    if (index < parts.length - 1 && signature.type !== "directory") return { type: "missing", signature: { type: "missing" } }
    if (index === parts.length - 1) return { type: signature.type, signature }
  }
  return { type: "missing", signature: { type: "missing" } }
}

function readNulTriples(output) {
  const triples = []
  let offset = 0
  while (offset < output.length) {
    const a = byte(output, 0, offset), b = a < 0 ? -1 : byte(output, 0, a + 1), c = b < 0 ? -1 : byte(output, 0, b + 1)
    if (a < 0 || b < 0 || c < 0) fail("attribute")
    triples.push([output.subarray(offset, a), output.subarray(a + 1, b), output.subarray(b + 1, c)])
    offset = c + 1
  }
  return triples
}

async function externalFilteredPaths(root, entries, externalFilters, filterOverrides, deadline) {
  const filtered = new Set()
  if (!externalFilters.size) return filtered
  const paths = new Map()
  for (const entry of entries) {
    for (const key of [entry.pathBytesBase64, entry.originalPathBytesBase64].filter(Boolean)) {
      const decoded = decodePath(key)
      if (decoded.text) paths.set(key, decoded.bytes)
    }
  }
  const pending = [...paths.entries()]
  for (let start = 0; start < pending.length;) {
    const batch = []
    let size = 0
    while (start < pending.length && size + pending[start][1].length + 1 <= FILTER_PATH_BATCH_BYTES) {
      batch.push(pending[start++]); size += batch[batch.length - 1][1].length + 1
    }
    if (!batch.length) {
      // Without consulting attributes we cannot safely label this content as a normal diff.
      filtered.add(pending[start][0]); start++; continue
    }
    const input = Buffer.concat(batch.flatMap(([, pathBytes]) => [pathBytes, Buffer.from([0])]), size)
    const result = await runGit([...gitArgs(filterOverrides), "check-attr", "-z", "--stdin", "filter"], {
      cwd: root, deadline, maxStdout: FILTER_PATH_BATCH_BYTES * 3, stdin: input,
    })
    if (result.overflow) throw new GitReviewError("malformedOutput", "Git returned oversized attribute metadata.")
    for (const [pathBytes, attributeBytes, valueBytes] of readNulTriples(result.stdout)) {
      if (attributeBytes.toString("ascii") !== "filter") fail("attribute")
      let value
      try { value = utf8.decode(valueBytes) } catch { fail("attribute") }
      if (!externalFilters.has(value)) continue
      filtered.add(pathBytes.toString("base64"))
    }
  }
  return filtered
}

async function captureIndexHead(repo, deadline, filterOverrides) {
  const result = await runGit([...gitArgs(filterOverrides), "rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: repo.root, deadline, maxStdout: 128, allowedExitCodes: [0, 1],
  })
  let headOid = null
  if (result.code === 0) {
    headOid = trimOutputNewline(result.stdout, "HEAD")
    if (!validObjectId(headOid)) throw new GitReviewError("malformedOutput", "Git returned an invalid HEAD object ID.")
  }
  return { headOid, indexSignature: await lstatSignature(repo.indexPath, deadline) }
}

function statusCommand() {
  return ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]
}

function statusMatchesEntry(entry, candidate) {
  return entry.pathBytesBase64 === candidate.pathBytesBase64
    && (entry.originalPathBytesBase64 || "") === (candidate.originalPathBytesBase64 || "")
}

function countMap(stats) {
  return new Map(stats.entries.map(entry => [
    `${entry.originalPathBytesBase64 || ""}\0${entry.pathBytesBase64}`, entry,
  ]))
}

function base64Pair(entry) { return `${entry.originalPathBytesBase64 || ""}\0${entry.pathBytesBase64}` }

function attachNumstat(entry, stats) {
  const value = stats.get(base64Pair(entry)) || stats.get(`\0${entry.pathBytesBase64}`)
  if (!value) return { additions: null, deletions: null, binary: null }
  return { additions: value.additions, deletions: value.deletions, binary: value.binary }
}

function entrySignature(pathInfo, originalInfo) {
  return { path: pathInfo.signature, ...(originalInfo ? { originalPath: originalInfo.signature } : {}) }
}

async function collectStatusAttempt(repo, deadline) {
  const filters = await readFilterSettings(repo.root, deadline)
  const before = await captureIndexHead(repo, deadline, filters.overrides)
  const status = await runGit([...gitArgs(filters.overrides), ...statusCommand()], {
    cwd: repo.root, deadline, maxStdout: GIT_STATUS_MAX_BYTES,
  })
  const parsed = parsePorcelainV2(status.stdout, { maxBytes: GIT_STATUS_MAX_BYTES, maxEntries: GIT_STATUS_MAX_ENTRIES })
  parsed.truncated ||= status.overflow
  let stats = { entries: [], truncated: false }, statsTruncated = false
  if (before.headOid && !parsed.truncated) {
    const numstat = await runGit([...gitArgs(filters.overrides), "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--numstat", "-z", "-M", "-l200", "HEAD"], {
      cwd: repo.root, deadline, maxStdout: GIT_STATUS_MAX_BYTES,
    })
    stats = parseNumstatZ(numstat.stdout, { maxBytes: GIT_STATUS_MAX_BYTES, maxEntries: GIT_STATUS_MAX_ENTRIES })
    stats.truncated ||= numstat.overflow
    statsTruncated = stats.truncated
  }
  const filtered = await externalFilteredPaths(repo.root, parsed.entries, filters.externalFilters, filters.overrides, deadline)
  const entries = []
  const counts = countMap(stats)
  for (const entry of parsed.entries) {
    const pathInfo = await fileInfo(repo.root, entry.pathBytesBase64, deadline)
    const originalInfo = entry.originalPathBytesBase64 ? await fileInfo(repo.root, entry.originalPathBytesBase64, deadline) : null
    const isFiltered = filtered.has(entry.pathBytesBase64) || Boolean(entry.originalPathBytesBase64 && filtered.has(entry.originalPathBytesBase64))
    const count = isFiltered ? { additions: null, deletions: null, binary: null } : attachNumstat(entry, counts)
    entries.push({
      ...entry, ...count,
      ...(isFiltered ? { contentState: "unsupportedPath", previewReason: "An external Git clean/smudge filter is configured; only metadata is available." } : {}),
      pathType: pathInfo.type, pathLinkTarget: pathInfo.linkTarget,
      ...(originalInfo ? { originalPathType: originalInfo.type, originalPathLinkTarget: originalInfo.linkTarget } : {}),
      signature: entrySignature(pathInfo, originalInfo),
    })
  }
  const after = await captureIndexHead(repo, deadline, filters.overrides)
  const confirmation = await runGit([...gitArgs(filters.overrides), ...statusCommand()], {
    cwd: repo.root, deadline, maxStdout: GIT_STATUS_MAX_BYTES,
  })
  const filtersAfter = await readFilterSettings(repo.root, deadline)
  const stable = sameValue(before, after) && status.overflow === confirmation.overflow
    && status.stdout.equals(confirmation.stdout)
    && filters.fingerprint === filtersAfter.fingerprint
  return {
    stable, filters, status, parsed, statsTruncated, entries, identity: after,
    fingerprint: statusFingerprint(repo, after, status.stdout, status.overflow, filters.fingerprint),
  }
}

async function collectStatus(repo, deadline) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await collectStatusAttempt(repo, deadline)
    if (last.stable) break
  }
  if (!last?.stable) throw new GitReviewError("stale", "The repository changed while its status was being collected.")
  const response = {
    schemaVersion: 1, state: "ready", root: repo.root, gitDir: repo.gitDir,
    headOid: last.identity.headOid, branch: last.parsed.branch.branch, detached: last.parsed.branch.detached,
    unborn: !last.identity.headOid, indexSignature: last.identity.indexSignature, fingerprint: last.fingerprint,
    filterFingerprint: last.filters.fingerprint,
    observedAt: Date.now(), entries: [], truncated: last.parsed.truncated,
    ...(last.statsTruncated ? { countsTruncated: true } : {}),
  }
  let used = Buffer.byteLength(JSON.stringify(response)) + 8
  for (const entry of last.entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1
    if (response.entries.length >= GIT_STATUS_MAX_ENTRIES || used + entryBytes > RESPONSE_MAX_BYTES) {
      response.truncated = true
      break
    }
    response.entries.push(entry); used += entryBytes
  }
  return response
}

async function recheckEntry(repo, requested, deadline) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    const filters = await readFilterSettings(repo.root, deadline)
    const before = await captureIndexHead(repo, deadline, filters.overrides)
    const status = await runGit([...gitArgs(filters.overrides), ...statusCommand()], {
      cwd: repo.root, deadline, maxStdout: GIT_STATUS_MAX_BYTES,
    })
    const parsed = parsePorcelainV2(status.stdout, { maxBytes: GIT_STATUS_MAX_BYTES, maxEntries: GIT_STATUS_MAX_ENTRIES })
    parsed.truncated ||= status.overflow
    const parsedEntry = parsed.entries.find(entry => statusMatchesEntry(requested, entry))
    let entry
    if (parsedEntry) {
      const filtered = await externalFilteredPaths(repo.root, [parsedEntry], filters.externalFilters, filters.overrides, deadline)
      const pathInfo = await fileInfo(repo.root, parsedEntry.pathBytesBase64, deadline)
      const originalInfo = parsedEntry.originalPathBytesBase64 ? await fileInfo(repo.root, parsedEntry.originalPathBytesBase64, deadline) : null
      const isFiltered = filtered.has(parsedEntry.pathBytesBase64) || Boolean(parsedEntry.originalPathBytesBase64 && filtered.has(parsedEntry.originalPathBytesBase64))
      entry = {
        ...parsedEntry,
        ...(isFiltered ? { contentState: "unsupportedPath", previewReason: "An external Git clean/smudge filter is configured; only metadata is available." } : {}),
        pathType: pathInfo.type, pathLinkTarget: pathInfo.linkTarget,
        ...(originalInfo ? { originalPathType: originalInfo.type, originalPathLinkTarget: originalInfo.linkTarget } : {}),
        signature: entrySignature(pathInfo, originalInfo),
      }
    }
    const after = await captureIndexHead(repo, deadline, filters.overrides)
    const confirmation = await runGit([...gitArgs(filters.overrides), ...statusCommand()], {
      cwd: repo.root, deadline, maxStdout: GIT_STATUS_MAX_BYTES,
    })
    const filtersAfter = await readFilterSettings(repo.root, deadline)
    const stable = sameValue(before, after) && status.overflow === confirmation.overflow
      && status.stdout.equals(confirmation.stdout) && filters.fingerprint === filtersAfter.fingerprint
    last = {
      stable, truncated: parsed.truncated, entry,
      fingerprint: statusFingerprint(repo, after, status.stdout, status.overflow, filters.fingerprint),
    }
    if (stable) return last
  }
  if (last?.stable) return last
  throw new GitReviewError("stale", "The repository changed while its diff identity was being checked.")
}

function plainObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }

function validateRequest(request) {
  if (!plainObject(request)) throw new GitReviewError("invalidRequest", "Git inspection request is invalid.")
  let encoded
  try { encoded = JSON.stringify(request) } catch { throw new GitReviewError("invalidRequest", "Git inspection request is invalid.") }
  if (!encoded || Buffer.byteLength(encoded) > REQUEST_MAX_BYTES) throw new GitReviewError("invalidRequest", "Git inspection request exceeds its 256 KiB limit.")
  const cwd = validateCwd(request.cwd)
  if (request.operation === "status") return { operation: "status", cwd }
  if (request.operation !== "diff" || typeof request.root !== "string" || request.root.length > 4096
    || !isAbsolute(request.root) || request.root.includes("\0") || !/^[a-fA-F0-9]{64}$/.test(request.fingerprint)
    || !["combined", "staged", "unstaged"].includes(request.view) || !plainObject(request.entry)) {
    throw new GitReviewError("invalidRequest", "Git diff request is invalid.")
  }
  const entry = request.entry
  decodePath(entry.pathBytesBase64)
  if (entry.originalPathBytesBase64 !== undefined) decodePath(entry.originalPathBytesBase64)
  if (!plainObject(entry.signature) || !["modified", "added", "deleted", "renamed", "copied", "untracked", "conflicted", "submodule", "typeChanged"].includes(entry.kind)) {
    throw new GitReviewError("invalidRequest", "Git diff entry is invalid.")
  }
  return { operation: "diff", cwd, root: request.root, fingerprint: request.fingerprint, view: request.view, entry }
}

function staleDiff(path, reason = "The repository changed. Refresh its status before opening this diff.") {
  return { state: "stale", path, reason: safeMessage(reason), observedAt: Date.now() }
}

function currentEntry(snapshot, requested) {
  return snapshot.entries.find(entry => statusMatchesEntry(requested, entry))
}

function safePathLabel(entry) { return entry?.path || "" }

function emptyDiff(path) { return { state: "ready", path, patch: "", observedAt: Date.now() }
}

function specialDiff(entry) {
  const path = safePathLabel(entry)
  if (entry.kind === "conflicted") return { state: "conflict", path, reason: "Resolve this merge conflict before reviewing a text diff.", observedAt: Date.now() }
  if (entry.kind === "submodule") return { state: "submodule", path, reason: "Submodules are shown as a summary; their contents are not traversed.", observedAt: Date.now() }
  if (entry.pathType === "unsupportedPath" || entry.contentState === "unsupportedPath") {
    return { state: "unsupportedPath", path, reason: entry.previewReason || "This path cannot be safely opened as UTF-8 content.", observedAt: Date.now() }
  }
  if (entry.pathType === "symlink" || entry.originalPathType === "symlink") {
    const target = entry.pathLinkTarget || entry.originalPathLinkTarget
    return { state: "symlink", path, reason: target ? `Symbolic link target: ${target}` : "Symbolic link content is not followed.", observedAt: Date.now() }
  }
}

function diffArguments(repo, entry, view, unborn, filterOverrides) {
  const paths = [entry.originalPathBytesBase64, entry.pathBytesBase64].filter(Boolean)
  const decoded = paths.map(value => repoRelativePath(repo.root, value))
  if (decoded.some(path => !path.text)) throw new GitReviewError("invalidPath", "This path cannot be safely opened as UTF-8 content.")
  const names = [...new Set(decoded.map(path => path.text))]
  const untracked = entry.kind === "untracked"
  const combinedUnborn = unborn && view === "combined"
  if (untracked && view === "staged") return { empty: true }
  if ((untracked && view !== "staged") || combinedUnborn) {
    if (entry.pathType === "missing") return { empty: true }
    return { args: [...gitArgs(filterOverrides), "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", names.at(-1)], noIndex: true }
  }
  const args = [...gitArgs(filterOverrides), "diff"]
  if (view === "staged") args.push("--cached")
  if ((view === "combined" || view === "staged") && !unborn) args.push("HEAD")
  args.push("--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short", "-M", "-l200", "--", ...names)
  return { args }
}

async function readDiffPatch(repo, entry, view, snapshot, deadline) {
  const special = specialDiff(entry)
  if (special) return special
  const filters = await readFilterSettings(repo.root, deadline)
  if (filters.fingerprint !== snapshot.filterFingerprint) return staleDiff(entry.path, "Git filter configuration changed. Refresh repository status before opening this diff.")
  const args = diffArguments(repo, entry, view, snapshot.unborn, filters.overrides)
  if (args.empty) return emptyDiff(entry.path)
  const result = await runGit(args.args, {
    cwd: repo.root, deadline, maxStdout: GIT_DIFF_MAX_BYTES, allowedExitCodes: args.noIndex ? [0, 1] : [0],
  })
  if (result.overflow) return { state: "tooLarge", path: entry.path, reason: "This diff exceeds the 512 KiB preview limit.", observedAt: Date.now() }
  if (result.stdout.includes(Buffer.from("Binary files ")) || result.stdout.includes(Buffer.from("GIT binary patch"))) {
    return { state: "binary", path: entry.path, reason: "Binary content is not rendered as a text diff.", observedAt: Date.now() }
  }
  let patch
  try { patch = utf8.decode(result.stdout) } catch {
    return { state: "binary", path: entry.path, reason: "Git returned non-UTF-8 diff content.", observedAt: Date.now() }
  }
  const lines = patch ? patch.split("\n").length - (patch.endsWith("\n") ? 1 : 0) : 0
  if (lines > GIT_DIFF_MAX_LINES) return { state: "tooLarge", path: entry.path, reason: "This diff exceeds the 10,000-line preview limit.", observedAt: Date.now() }
  const response = { state: "ready", path: entry.path, patch, observedAt: Date.now() }
  if (Buffer.byteLength(JSON.stringify(response)) > RESPONSE_MAX_BYTES) {
    return { state: "tooLarge", path: entry.path, reason: "This diff exceeds the safe response limit.", observedAt: Date.now() }
  }
  return response
}

function validateDiffEntry(requested, current) {
  return current && requested.kind === current.kind && sameValue(requested.signature, current.signature)
    && requested.pathType === current.pathType && requested.originalPathType === current.originalPathType
    && requested.contentState === current.contentState
}

async function inspectDiff(request, deadline) {
  const requestedPath = displayPath(decodePath(request.entry.pathBytesBase64).bytes)
  let repo, snapshot
  try {
    repo = await resolveRepository(request.cwd, deadline)
    if (repo.state !== "ready" || repo.root !== request.root) return staleDiff(requestedPath)
    snapshot = await collectStatus(repo, deadline)
  } catch (error) {
    if (error?.code === "notRepository" || error?.code === "stale") return staleDiff(requestedPath)
    throw error
  }
  if (snapshot.truncated || snapshot.root !== request.root || snapshot.fingerprint !== request.fingerprint) return staleDiff(requestedPath)
  let entry = currentEntry(snapshot, request.entry)
  if (!validateDiffEntry(request.entry, entry)) return staleDiff(entry?.path || requestedPath)
  const path = entry.path
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readDiffPatch(repo, entry, request.view, snapshot, deadline)
    if (["conflict", "submodule", "symlink", "unsupportedPath"].includes(result.state)) return result
    let after
    try { after = await recheckEntry(repo, request.entry, deadline) } catch (error) {
      if (error?.code === "stale") return staleDiff(path)
      throw error
    }
    if (after.truncated || after.fingerprint !== snapshot.fingerprint || !after.entry) return staleDiff(path)
    const changedEntry = after.entry
    if (changedEntry.contentState !== entry.contentState) return staleDiff(path, "Git filter attributes changed. Refresh repository status before opening this diff.")
    if (sameValue(entry.signature, changedEntry.signature)) return result
    if (attempt === 1) return staleDiff(path, "The file kept changing while its diff was being read. Refresh and try again.")
    entry = changedEntry
    snapshot = after
  }
  return staleDiff(path)
}

/** Inspects a selected checkout using fixed, read-only Git argv and bounded output. */
export async function inspectGit(rawRequest) {
  const request = validateRequest(rawRequest)
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  if (request.operation === "diff") return await inspectDiff(request, deadline)
  let repo
  try { repo = await resolveRepository(request.cwd, deadline) }
  catch (error) {
    if (error?.code === "notRepository") return { schemaVersion: 1, state: "notRepository", reason: safeMessage(error.message), observedAt: Date.now() }
    if (error?.code === "gitUnavailable") return { schemaVersion: 1, state: "gitUnavailable", reason: "Git is not installed or is unavailable on this host.", observedAt: Date.now() }
    throw error
  }
  if (repo.state !== "ready") return { schemaVersion: 1, state: "notRepository", reason: repo.reason, observedAt: Date.now() }
  try { return await collectStatus(repo, deadline) }
  catch (error) {
    if (error?.code === "notRepository") return { schemaVersion: 1, state: "notRepository", reason: safeMessage(error.message), observedAt: Date.now() }
    if (error?.code === "gitUnavailable") return { schemaVersion: 1, state: "gitUnavailable", reason: "Git is not installed or is unavailable on this host.", observedAt: Date.now() }
    throw error
  }
}
