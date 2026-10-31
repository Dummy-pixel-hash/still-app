import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const bootstrap = fileURLToPath(new URL("../src-tauri/agent-host/bootstrap.mjs", import.meta.url))

test("remote bootstrap receives bundled sources on stdin before forwarding ACP", async () => {
  const home = await mkdtemp(join(tmpdir(), "still-agent-bootstrap-"))
  const child = spawn(process.execPath, [bootstrap], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
  const waitFor = expected => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${expected}. stdout=${stdout} stderr=${stderr}`)) }, 5000)
    const check = () => { if (stdout.includes(expected)) { cleanup(); resolve() } }
    const onExit = code => { cleanup(); reject(new Error(`Bootstrap exited (${code}) before ${expected}. stderr=${stderr}`)) }
    const cleanup = () => { clearTimeout(timeout); child.off("exit", onExit); child.stdout.off("data", check) }
    child.once("exit", onExit); check()
    child.stdout.on("data", check)
  })
  try {
    const source = 'process.stdout.write("FIXTURE_ATTACHED\\n");process.stdin.once("data",data=>process.stdout.write(`FORWARDED:${data.toString().trim()}\\n`))'
    const config = { executionId: "agent-bootstrap-test", conversationId: "test", agentId: "pi", cwd: home, create: true, after: 0, command: [], env: {}, source, todosSource: "export const todoFixture = true", todoPiSource: "export default function fixture() {}" }
    child.stdin.write(`${Buffer.from(JSON.stringify(config)).toString("base64")}\n`)
    await waitFor("STILL_BOOTSTRAP_READY\n")
    await waitFor("FIXTURE_ATTACHED\n")
    assert.ok(stdout.indexOf("STILL_BOOTSTRAP_READY\n") < stdout.indexOf("FIXTURE_ATTACHED\n"), "bootstrap readiness precedes any ACP child output")

    const directory = join(home, ".local", "state", "still", "agents", config.executionId)
    assert.equal(await readFile(join(directory, "transport.mjs"), "utf8"), source)
    assert.equal(await readFile(join(directory, "todos.mjs"), "utf8"), config.todosSource)
    assert.equal(await readFile(join(directory, "todo-pi.mjs"), "utf8"), config.todoPiSource)
    assert.equal((await stat(join(directory, "transport.mjs"))).mode & 0o777, 0o600)

    child.stdin.write("ACP bootstrap-stream-check\n")
    await waitFor("FORWARDED:ACP bootstrap-stream-check\n")
    child.stdin.end()
    const [code] = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (...result) => resolve(result)) })
    assert.equal(code, 0, stderr)
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await rm(home, { recursive: true, force: true })
  }
})

test("near-limit Todo seed is moved to a private file before the worker config becomes argv", async () => {
  const home = await mkdtemp(join(tmpdir(), "still-agent-seed-bootstrap-"))
  const child = spawn(process.execPath, [bootstrap], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
  const waitFor = expected => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${expected}. stdout=${stdout} stderr=${stderr}`)) }, 5000)
    const check = () => { if (stdout.includes(expected)) { cleanup(); resolve() } }
    const onExit = code => { cleanup(); reject(new Error(`Bootstrap exited (${code}) before ${expected}. stderr=${stderr}`)) }
    const cleanup = () => { clearTimeout(timeout); child.off("exit", onExit); child.stdout.off("data", check) }
    child.once("exit", onExit); check(); child.stdout.on("data", check)
  })
  try {
    const repeatedTitle = "😀".repeat(500), repeatedDetail = "🧭".repeat(500)
    const todoSeed = { revision: 12, activeId: "task-0", items: Array.from({ length: 100 }, (_, index) => ({
      id: `task-${index}`, title: repeatedTitle, status: "pending", createdBy: "agent", updatedBy: "agent", createdAt: 1, startedAt: 1, detail: repeatedDetail,
    })) }
    const source = `const config = JSON.parse(Buffer.from(process.argv[3], "base64").toString("utf8"));\nprocess.stdout.write("SEED_CONFIG:"+JSON.stringify({hasTodoSeed:config.hasTodoSeed,containsSeed:Object.hasOwn(config,"todoSeed"),argvBytes:Buffer.byteLength(process.argv[3])})+"\\n");\nprocess.stdout.write("FIXTURE_ATTACHED\\n");process.stdin.once("data",data=>process.stdout.write("FORWARDED:"+data.toString().trim()+"\\n"));`
    const config = { executionId: "agent-seed-bootstrap", conversationId: "test-seed", agentId: "pi", cwd: home, create: true, after: 0, command: [], env: {}, source, todosSource: "export const todoFixture = true", todoPiSource: "export default function fixture() {}", todoSeed }
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
    assert.ok(encoded.length > 128 * 1024, "stdin fixture must exceed the Linux per-argument limit before extraction")
    child.stdin.write(`${encoded}\n`)
    await waitFor("STILL_BOOTSTRAP_READY\n")
    await waitFor("FIXTURE_ATTACHED\n")
    const command = stdout.match(/SEED_CONFIG:([^\n]+)/)
    assert.ok(command, `worker did not report its arguments: ${stdout}`)
    const transportConfig = JSON.parse(command[1])
    assert.equal(transportConfig.hasTodoSeed, true)
    assert.equal(transportConfig.containsSeed, false)
    assert.ok(transportConfig.argvBytes < 128 * 1024, "the second spawn argument must stay below Linux's limit")

    const directory = join(home, ".local", "state", "still", "agents", config.executionId)
    const seedFile = join(directory, "todo-seed.json")
    assert.deepEqual(JSON.parse(await readFile(seedFile, "utf8")), todoSeed)
    assert.equal((await stat(seedFile)).mode & 0o777, 0o600)
    child.stdin.write("seed-bootstrap-stream-check\n")
    await waitFor("FORWARDED:seed-bootstrap-stream-check\n")
    child.stdin.end()
    const [code] = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (...result) => resolve(result)) })
    assert.equal(code, 0, stderr)
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await rm(home, { recursive: true, force: true })
  }
})
