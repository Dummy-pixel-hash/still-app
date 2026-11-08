import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "vite"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { testConnection } from "../src-tauri/agent-host/acp-probe.mjs"

const host = JSON.stringify(["dev.example", 22, "user"])
const agent = { id: "custom-test", hostKey: host, name: "Custom CLI", executable: "/opt/agent with spaces", args: ["--acp", "$(touch never)", "a b", ""], transport: "acp-v1" }
let exportsPromise
async function modules() {
  exportsPromise ||= (async () => {
    const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" })
    try {
      return Object.assign({}, ...await Promise.all(["/src/agents/customAgents.ts", "/src/agents/workspace.ts", "/src/session/agentStorage.ts", "/src/bridge/nativeBridge.ts", "/src/session/agentDiscovery.ts"].map(path => server.ssrLoadModule(path))))
    } finally { await server.close() }
  })()
  return exportsPromise
}

test("custom definitions are server scoped and cannot silently change resume commands", async () => {
  const { customAgentError, agentsForHost, customLaunchOptions, isCustomAgent } = await modules()
  assert.equal(customAgentError(agent, host), undefined)
  assert.equal(isCustomAgent(agent, host), true)
  assert.equal(isCustomAgent(agent, "other"), false)
  assert.equal(isCustomAgent({ ...agent, args: [null] }, host), false)
  assert.equal(agentsForHost(host, { [host]: [agent] }).at(-1).id, agent.id)
  assert.equal(agentsForHost("other", { [host]: [agent] }).some(row => row.id === agent.id), false)
  assert.deepEqual(customLaunchOptions(agent.id, host, { [host]: [{ ...agent, args: ["changed"] }] }, agent), agent)
  assert.throws(() => customLaunchOptions(agent.id, host, {}, agent), /removed/)
  assert.equal(customLaunchOptions("codex", host, {}), undefined)
  for (const patch of [{ executable: "cli --acp" }, { executable: "$(evil)" }, { executable: "./cli" }, { name: "\n" }, { transport: "unknown" }, { args: ["\0"] }, { args: Array(65).fill("") }, { args: ["😀".repeat(1100)] }]) {
    assert.ok(customAgentError({ ...agent, ...patch }, host), JSON.stringify(patch))
  }
})

test("custom definitions persist, reject malformed saved values, and invalidate discovery for argument edits", async () => {
  const { registerNativeBridge, saveAgentWorkspace, readLibraryPreferences, agentDiscoverySelectionKey } = await modules()
  registerNativeBridge({ agentSaveWorkspace: async () => {} })
  saveAgentWorkspace("library", { customAgents: { [host]: [agent, { ...agent, id: "codex" }, { ...agent, hostKey: "other" }, null], other: [agent] } })
  assert.deepEqual(readLibraryPreferences().customAgents[host], [agent])
  assert.deepEqual(readLibraryPreferences().customAgents.other, [])
  const key = custom => agentDiscoverySelectionKey("ssh", {}, [agent.id], [custom])
  assert.notEqual(key(agent), key({ ...agent, args: ["different"] }))
  assert.notEqual(key(agent), key({ ...agent, executable: "/different" }))
})

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "still-acp-probe-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("ACP test passes literal arguments, negotiates only initialize, and stops the process", () => withFixture(async directory => {
  const file = join(directory, "argv.json"), pid = join(directory, "pid")
  const source = `require('node:fs').writeFileSync(${JSON.stringify(pid)},String(process.pid));process.stdin.once('data',line=>{const request=JSON.parse(line);require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({args:process.argv.slice(1),method:request.method}));console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{}}}))});setInterval(()=>{},1000)`
  assert.deepEqual(await testConnection(process.execPath, ["-e", source, "--", ...agent.args]), { ready: true })
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { args: agent.args, method: "initialize" })
  const childPid = Number.parseInt(await readFile(pid, "utf8"))
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" })
}))

for (const [label, source, expected] of [
  ["wrong protocol", `process.stdin.once('data',()=>console.log('not json'));setInterval(()=>{},1000)`, /did not speak ACP/],
  ["null response", `process.stdin.once('data',()=>console.log('null'));setInterval(()=>{},1000)`, /did not speak ACP/],
  ["wrong version", `process.stdin.once('data',()=>console.log(JSON.stringify({id:'still-probe',result:{protocolVersion:2,agentCapabilities:{}}})));setInterval(()=>{},1000)`, /incompatible ACP/],
  ["rejected initialization", `process.stdin.once('data',()=>console.log(JSON.stringify({id:'still-probe',error:{code:-32000,message:'rejected'}})));setInterval(()=>{},1000)`, /rejected ACP/],
  ["early exit", `process.exit(1)`, /exited before/],
  ["timeout", `setInterval(()=>{},1000)`, /timed out/],
  ["excessive output", `process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)`, /too much output/],
]) test(`ACP test handles ${label} and terminates the child`, () => withFixture(async directory => {
  const pidFile = join(directory, "pid")
  const result = await testConnection(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));${source}`], 700)
  assert.match(result.error, expected)
  const pid = Number.parseInt(await readFile(pidFile, "utf8"))
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
}))

test("ACP test reports a missing executable", async () => {
  assert.match((await testConnection("/definitely/no/agent", [])).error, /not found/)
})

test("bundled ACP test runs through the remote node -e entry point", async () => {
  const source = await readFile(new URL("../src-tauri/agent-host/acp-probe.mjs", import.meta.url), "utf8")
  const config = { executable: process.execPath, args: ["-e", `process.stdin.once('data',line=>{const request=JSON.parse(line);console.log(JSON.stringify({id:request.id,result:{protocolVersion:1,agentCapabilities:{}}}))});setInterval(()=>{},1000)`] }
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, "--", "--still-acp-probe", Buffer.from(JSON.stringify(config)).toString("base64")])
  let output = "", error = ""
  child.stdout.on("data", data => output += data); child.stderr.on("data", data => error += data)
  const code = await new Promise(resolve => child.on("exit", resolve))
  assert.equal(code, 0, error)
  assert.match(output, /STILL_ACP_PROBE:\{"ready":true\}/)
})


test("ACP test kills descendants even when the parent ignores termination", () => withFixture(async directory => {
  const pidFile = join(directory, "descendant")
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
  const parent = `process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`
  assert.match((await testConnection(process.execPath, ["-e", parent], 700)).error, /timed out/)
  const pid = Number.parseInt(await readFile(pidFile, "utf8"))
  // An orphan may briefly be a zombie until the OS reaps it; neither state runs code.
  try { assert.equal((await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2], "Z") }
  catch (error) { if (error.code !== "ENOENT") throw error }
}))
