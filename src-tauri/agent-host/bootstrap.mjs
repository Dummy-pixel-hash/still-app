// Keep the SSH exec command short: Linux limits each argument to 128 KiB.
// Configuration (including bundled worker sources) arrives as the first stdin line.
import { spawn } from "node:child_process"
import { mkdirSync, chmodSync, lstatSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const READY = "STILL_BOOTSTRAP_READY"
const ERROR = "STILL_BOOTSTRAP_ERROR:"
const LIMIT = 2 * 1024 * 1024

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
  config.directory = directory
  if (!config.executionId || !Array.isArray(config.command)) throw new Error("Invalid remote agent configuration")
  if (config.create) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("Unsafe remote agent directory")
  chmodSync(directory, 0o700)
  if (config.create) {
    for (const [name, source] of [["transport.mjs", config.source], ["todos.mjs", config.todosSource], ["todo-pi.mjs", config.todoPiSource]]) {
      if (typeof source !== "string") throw new Error(`Missing remote source: ${name}`)
      writeFileSync(join(directory, name), source, { mode: 0o600, flag: "wx" })
    }
  }
  delete config.source
  delete config.todosSource
  delete config.todoPiSource
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
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.stdout.write(`${ERROR}${message.replace(/[\r\n]/g, " ")}\n`)
  process.exitCode = 1
}
