// Keep the SSH exec command short: Linux limits each argument to 128 KiB.
// Configuration (including bundled worker sources) arrives as the first stdin line.
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, chmodSync, lstatSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const READY = "STILL_BOOTSTRAP_READY"
const ERROR = "STILL_BOOTSTRAP_ERROR:"
const LIMIT = 2 * 1024 * 1024
let stagingDirectory

function requireNewDirectory(path) {
  try { lstatSync(path) } catch (error) { if (error.code === "ENOENT") return; throw error }
  throw new Error("Refusing to replace an existing execution directory. Its files were kept.")
}

function readConfiguration() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const cleanup = () => {
      process.stdin.off("data", receive)
      process.stdin.off("error", fail)
    }
    const fail = error => { cleanup(); reject(error) }
    const receive = chunk => {
      const input = Buffer.from(chunk)
      const newline = input.indexOf(10)
      const line = newline < 0 ? input : input.subarray(0, newline)
      buffer = Buffer.concat([buffer, line])
      if (buffer.length > LIMIT) { fail(new Error("Remote bootstrap configuration is too large")); return }
      if (newline < 0) return
      if (input.subarray(newline + 1).length) { fail(new Error("Unexpected bytes after remote bootstrap configuration")); return }
      cleanup()
      process.stdin.pause()
      resolve(buffer.toString("utf8").replace(/\r$/, ""))
    }
    process.stdin.on("data", receive)
    process.stdin.once("error", fail)
    process.stdin.resume()
  })
}

try {
  const encoded = await readConfiguration()
  const config = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
  if (typeof config.executionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(config.executionId)) throw new Error("Invalid remote execution identity")
  const root = join(process.env.HOME, ".local", "state", "still", "agents")
  const directory = join(root, config.executionId)
  // New devices must not use an old worker's destructive attach path. Inspect
  // its persisted protocol before spawning its own transport implementation.
  if (!config.create && config.requireContinuity) {
    const { openSync, readFileSync, fstatSync, constants } = await import("node:fs")
    const fd = openSync(join(directory, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let state
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 16 * 1024 * 1024) throw new Error("Unsafe remote worker identity record")
      state = JSON.parse(readFileSync(fd, "utf8"))
    } finally { closeSync(fd) }
    if (state.executionId !== config.executionId || state.conversationId !== config.conversationId) throw new Error("Remote worker does not match this conversation")
    if (state.version < 4) throw new Error("This conversation needs a continuity-capable worker. Its existing connection was not replaced.")
  }
  config.directory = directory
  if (!config.executionId || !Array.isArray(config.command)) throw new Error("Invalid remote agent configuration")
  if (config.create) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const parent = lstatSync(root)
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o022) throw new Error("Unsafe remote execution parent")
    requireNewDirectory(directory)
    stagingDirectory = mkdtempSync(join(root, ".bootstrap-"))
  }
  const assetsDirectory = stagingDirectory || directory
  const stat = lstatSync(assetsDirectory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("Unsafe remote agent directory")
  chmodSync(assetsDirectory, 0o700)
  if (config.todoSeed !== undefined) {
    if (!config.create) throw new Error("Todo seed is only valid for a new execution")
    const bytes = Buffer.from(JSON.stringify(config.todoSeed))
    if (bytes.length > 1024 * 1024) throw new Error("Todo seed is too large for private bootstrap storage")
    const fd = openSync(join(assetsDirectory, "todo-seed.json"), "wx", 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  }
  const hasTodoSeed = config.todoSeed !== undefined
  delete config.todoSeed
  config.hasTodoSeed = hasTodoSeed
  if (config.create) {
    for (const [name, source] of [["transport.mjs", config.source], ["todos.mjs", config.todosSource], ["todo-pi.mjs", config.todoPiSource]]) {
      if (typeof source !== "string") throw new Error(`Missing remote source: ${name}`)
      writeFileSync(join(assetsDirectory, name), source, { mode: 0o600, flag: "wx" })
    }
    if (typeof config.recoverySource === "string") writeFileSync(join(assetsDirectory, "recovery.mjs"), config.recoverySource, { mode: 0o600, flag: "wx" })
    if (typeof config.sharedLibrarySource === "string") writeFileSync(join(assetsDirectory, "shared-library.mjs"), config.sharedLibrarySource, { mode: 0o600, flag: "wx" })
    if (typeof config.subagentsSource === "string") writeFileSync(join(assetsDirectory, "subagents.mjs"), config.subagentsSource, { mode: 0o600, flag: "wx" })
    if (typeof config.bridgeSource === "string") writeFileSync(join(assetsDirectory, "bridge.mjs"), config.bridgeSource, { mode: 0o600, flag: "wx" })
  }
  delete config.source
  delete config.todosSource
  delete config.todoPiSource
  delete config.recoverySource
  config.sharedLibrary = typeof config.sharedLibrarySource === "string"
  delete config.sharedLibrarySource
  config.serverSubagents = typeof config.subagentsSource === "string"
  delete config.subagentsSource
  if (typeof config.bridgeSource === "string" && config.env?.STILL_AGENT_DRIVER) config.command = [process.execPath, join(directory, "bridge.mjs")]
  delete config.bridgeSource
  if (config.recoverFrom) {
    const { verifyExecutionRecovery } = await import(pathToFileURL(join(assetsDirectory, "recovery.mjs")).href)
    verifyExecutionRecovery(directory, config)
  }
  // Publish bundled assets only after read-only recovery checks have succeeded.
  if (stagingDirectory) {
    requireNewDirectory(directory); renameSync(stagingDirectory, directory); stagingDirectory = undefined
    const parent = openSync(root, "r"); try { fsyncSync(parent) } finally { closeSync(parent) }
  }
  const child = spawn(process.execPath, [join(directory, "transport.mjs"), "attach", Buffer.from(JSON.stringify(config)).toString("base64")], { stdio: ["pipe", "pipe", "inherit"] })
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  await new Promise(resolve => process.stdout.write(`${READY}\n`, resolve))
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
  child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
  child.on("exit", code => { process.exitCode = code ?? 1 })
} catch (error) {
  if (stagingDirectory) { try { rmSync(stagingDirectory, { recursive: true, force: true }) } catch {} }
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.stdout.write(`${ERROR}${message.replace(/[\r\n]/g, " ")}\n`)
  process.exitCode = 1
}
