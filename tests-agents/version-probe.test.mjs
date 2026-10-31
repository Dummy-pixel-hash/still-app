import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const nativeSource = await readFile(new URL("../src-tauri/src/agent.rs", import.meta.url), "utf8")
const probe = nativeSource.match(/const VERSION_PROBE: &str = r#"([\s\S]*?)"#;/)?.[1]
assert.ok(probe, "test must execute the actual native bundled version probe")

const run = (entries, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", probe, Buffer.from(JSON.stringify(entries)).toString("base64")], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "", stderr = ""
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Version probe exceeded its outer test deadline")) }, 5000)
  child.once("error", error => { clearTimeout(timer); reject(error) })
  child.once("close", code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `Probe exited ${code}`)) })
})

test("selected executable probe resolves overrides, normalizes Unicode/ANSI and requires successful output", async () => {
  if (process.platform === "win32") return // The installed probe runs on POSIX remote hosts.
  const directory = await mkdtemp("/tmp/opencode/still-version-probe-")
  try {
    const writeCli = async (name, source) => {
      const path = join(directory, name)
      await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 })
      return path
    }
    const normalized = `Pi ${"😀".repeat(220)}`
    const pi = await writeCli("pi", `process.stdout.write("\\u001b[32m"+${JSON.stringify(normalized)}+"\\u001b[0m\\n")`)
    const failing = await writeCli("failure", `process.stdout.write("should not be reported");process.exitCode=2`)
    const stderr = await writeCli("stderr", `process.stderr.write("Claude Code 2.fixture\\n")`)
    const native = await writeCli("native", `console.log("native")`)
    const empty = await writeCli("empty", ``)
    const output = await run([
      { id: "pi", executable: "pi" }, { id: "codex", executable: failing }, { id: "claude", executable: stderr },
      { id: "opencode", executable: native }, { id: "gemini", executable: empty },
    ], { PATH: `${directory}:${process.env.PATH}` })
    assert.ok(output.stdout.includes(`STILL_EXECUTABLE:pi:${pi}\n`), "the exact PATH-selected executable is retained")
    const version = output.stdout.split("\n").find(line => line.startsWith("STILL_VERSION:pi:")).slice("STILL_VERSION:pi:".length)
    assert.equal([...version].length, 200)
    assert.ok(!/\p{Cc}/u.test(version))
    assert.ok(output.stdout.includes("STILL_VERSION:claude:Claude Code 2.fixture"))
    for (const id of ["codex", "opencode", "gemini"]) assert.ok(!output.stdout.includes(`STILL_VERSION:${id}:`))
    const override = await run([{ id: "pi", executable: stderr }, { id: "codex", executable: join(directory, "missing") }])
    assert.ok(override.stdout.includes(`STILL_EXECUTABLE:pi:${stderr}`))
    assert.ok(override.stdout.includes("STILL_VERSION:pi:Claude Code 2.fixture"))
    assert.ok(!override.stdout.includes("STILL_VERSION:codex:"))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("version probe bounds combined stdout/stderr and kills timed-out process groups", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp("/tmp/opencode/still-version-bounds-")
  try {
    const excessive = join(directory, "excessive"), hanging = join(directory, "hanging"), marker = join(directory, "descendant-survived")
    await writeFile(excessive, `#!${process.execPath}\nprocess.stdout.write("a".repeat(9000));process.stderr.write("b".repeat(9000));\n`, { mode: 0o700 })
    await writeFile(hanging, `#!${process.execPath}\nconst {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(`setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"survived"),2600)`)}],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000);\n`, { mode: 0o700 })
    const begin = Date.now()
    const output = await run([{ id: "pi", executable: excessive }, { id: "codex", executable: hanging }])
    assert.ok(Date.now() - begin < 4000)
    assert.ok(!output.stdout.includes("STILL_VERSION:pi:"), "16 KiB is shared across both streams, not per stream")
    assert.ok(!output.stdout.includes("STILL_VERSION:codex:"))
    await new Promise(resolve => setTimeout(resolve, 850))
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "the timeout must reap descendants retaining probe pipes")
  } finally { await rm(directory, { recursive: true, force: true }) }
})
