/** Local, no-prompt inventory of the installed providers through Still's actual drivers.
 * Usage: node scripts/audit-agent-capabilities.mjs [opencode pi codex claude gemini]
 * Startup can create empty provider sessions in the printed temporary project.
 */
import { mkdir, mkdtemp } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A Still-managed terminal can inherit these. Importing the driver must not start
// a second protocol host, and fixture/probe children must not inherit that role.
for (const key of ["STILL_AGENT_DRIVER", "STILL_AGENT_EXECUTABLE", "STILL_AGENT_CATALOG", "STILL_TEST_PEER", "STILL_TEST_NO_HISTORY"]) delete process.env[key]
const { OpenCodeDriver, PiDriver, CodexDriver, ClaudeDriver, Peer } = await import("../src-tauri/agent-host/bridge.mjs")
const definitions = {
  opencode: { transport: "http-v2+sse", Driver: OpenCodeDriver },
  pi: { transport: "pi-rpc", Driver: PiDriver },
  codex: { transport: "codex-app-server", Driver: CodexDriver },
  claude: { transport: "claude-stream-json", Driver: ClaudeDriver },
  gemini: { transport: "acp-v1" },
}
const selected = [...new Set(process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(definitions))]
if (selected.some(id => !Object.hasOwn(definitions, id))) throw new Error(`Choose providers from: ${Object.keys(definitions).join(", ")}`)
const temporaryRoot = process.platform === "linux" ? "/tmp/opencode" : tmpdir()
await mkdir(temporaryRoot, { recursive: true })
const cwd = await mkdtemp(join(temporaryRoot, "still-capability-audit-"))
process.chdir(cwd)
const message = error => String(error?.message || error).replace(/\x1b\[[0-9;]*m/g, "").slice(0, 500)
const countOptions = options => (options || []).reduce((sum, option) => sum + (Array.isArray(option.options) ? option.options.length : 1), 0)

async function inspect(id) {
  const { Driver, transport } = definitions[id]
  const version = spawnSync(id, ["--version"], { encoding: "utf8", timeout: 15000, maxBuffer: 16384 })
  const report = { provider: id, executable: id, transport, installed: version.error?.code !== "ENOENT", version: version.status === 0 ? version.stdout.trim().slice(0, 200) : null }
  if (!report.installed) return { ...report, session: "unverified", reason: "Executable not found on this local PATH." }
  if (!report.version) report.versionCheck = "unverified"
  let driver, peer, timer, expired = false
  const updates = new Set()
  try {
    const probe = async () => {
      if (id === "gemini") {
        peer = new Peer(id, ["--acp"], event => { if (event.params?.update?.sessionUpdate) updates.add(event.params.update.sessionUpdate) })
        const init = await peer.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } }, clientInfo: { name: "still-capability-audit", version: "0.1.1" } })
        report.initialize = {
          protocolVersion: init.protocolVersion,
          name: init.agentInfo?.name,
          version: init.agentInfo?.version,
          loadSession: init.agentCapabilities?.loadSession,
          promptCapabilities: init.agentCapabilities?.promptCapabilities,
        }
        if (init.protocolVersion !== 1) throw new Error("Provider did not negotiate ACP v1.")
        const session = await peer.request("session/new", { cwd, mcpServers: [] })
        report.sessionIdentityReturned = typeof session.sessionId === "string" && session.sessionId.length > 0
        report.configCategories = (session.configOptions || []).map(option => option.category)
        report.modelOptions = session.models?.availableModels?.length ?? 0
        report.modeOptions = session.modes?.availableModes?.map(mode => mode.id) || []
        report.sessionMetaResumable = session._meta?.resumable ?? null
      } else {
        driver = new Driver({
          questionGeneration: 0,
          update: update => updates.add(update.sessionUpdate),
          ask: async () => { throw new Error("Inventory encountered an interactive provider request.") },
          cancelQuestions() {},
        }, id)
        await driver.start()
        report.sessionIdentityReturned = !!driver.id
        report.reportedServerVersion = driver.version || null
        report.configCategories = driver.configs.map(option => option.category)
        report.modelOptions = countOptions(driver.configs.find(option => option.category === "model")?.options)
        report.commandCount = driver.commands.length
        report.todoCommandNames = driver.commands.filter(command => /todo|task/i.test(command.name)).map(command => command.name)
        report.resumable = driver.resumable === true
        report.historyCapabilities = driver.historyCapabilities
        if (id === "codex") {
          const methods = ["collaborationMode/list", "permissionProfile/list", "account/usage/read"]
          report.nativeReadbacks = await Promise.all(methods.map(async method => {
            try {
              const result = await driver.peer.request(method, {})
              return { method, status: "verified", fields: Object.keys(result), ...(Array.isArray(result.data) ? { count: result.data.length } : {}) }
            } catch (error) { return { method, status: "unverified", reason: message(error) } }
          }))
        }
      }
      if (expired) return
      if (!report.sessionIdentityReturned) throw new Error("Provider did not return a session identity.")
      report.session = "verified"
    }
    await Promise.race([probe(), new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("Provider inventory exceeded 65 seconds.")) }, 65000) })])
  } catch (error) {
    report.session = "unverified"
    report.reason = message(error)
  } finally {
    clearTimeout(timer)
    try { if (driver) await driver.close(); else if (peer) await peer.close() }
    catch (error) { report.cleanupError = message(error) }
  }
  return { ...report, observedUpdates: [...updates] }
}

const results = await Promise.allSettled(selected.map(inspect))
console.log(JSON.stringify({
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  scope: "local installed providers; empty project; startup and read-only inventories; no model prompts",
  nodeVersion: process.versions.node,
  cwd,
  providers: results.map((result, index) => result.status === "fulfilled" ? result.value : { provider: selected[index], session: "unverified", reason: message(result.reason) }),
}, null, 2))
if (results.some(result => result.status === "rejected" || result.value.cleanupError || result.value.installed && result.value.session !== "verified")) process.exitCode = 1
