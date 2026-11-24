import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { ChildTransport, createServerSubagents } from "../src-tauri/agent-host/subagents.mjs"
import { hostTools, requestSubagents } from "../src-tauri/agent-host/todos.mjs"
import { operationId as piOperationId } from "../src-tauri/agent-host/todo-pi.mjs"

const sources = fileURLToPath(new URL("../src-tauri/agent-host/", import.meta.url))
const peer = `
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
let model='a',mode='ask',active=null,timer=null;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const options=()=>[{id:'model',name:'Model',category:'model',type:'select',currentValue:model,options:[{value:'a',name:'A'},{value:'b',name:'B'}]}, {id:'effort',name:'Reasoning',category:'thought_level',type:'select',currentValue:model==='b'?'high':'medium',options:[{value:model==='b'?'high':'medium',name:'Available effort'}]}, {id:'mode',name:'Mode',category:'mode',type:'select',currentValue:mode,options:[{value:'ask',name:'Ask'},{value:'plan',name:'Plan'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
 else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture-'+process.pid,configOptions:options(),fixtureTodoRoute:{socket:process.env.STILL_TODO_SOCKET,token:process.env.STILL_TODO_TOKEN}}});
 else if(m.method==='session/set_config_option'){if(m.params.configId==='model')model=m.params.value;if(m.params.configId==='mode'){mode=m.params.value;if(mode==='plan')model='a';}send({jsonrpc:'2.0',id:m.id,result:{configOptions:options()}});}
 else if(m.method==='session/prompt'){
   active=m.id;const text=m.params.prompt.map(p=>p.text||'').join('');appendFileSync(process.argv[2],JSON.stringify({text,model,subagents:process.env.STILL_SUBAGENTS})+'\\n');
   if(text.includes('thought'))send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private reasoning'}}}});
   if(text.includes('permission task'))send({jsonrpc:'2.0',id:'approval',method:'session/request_permission',params:{toolCall:{title:'Needs user approval'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'}]}});
   else timer=setTimeout(()=>{send({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done'}}}});send({jsonrpc:'2.0',id:active,result:{stopReason:'end_turn'}});active=null;},text.includes('slow task')?500:40);
 } else if(m.method==='session/cancel'){clearTimeout(timer);if(active!==null)send({jsonrpc:'2.0',id:active,result:{stopReason:'cancelled'}});active=null;}
});
`

async function fixture(t) {
  const home = await mkdtemp("/tmp/opencode/still-server-subagents-")
  const before = process.env.HOME
  process.env.HOME = home
  const directory = join(home, ".local/state/still/agents/parent-execution")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const materialize = async target => {
    await mkdir(target, { recursive: true, mode: 0o700 })
    for (const name of ["supervisor.mjs", "todos.mjs", "todo-pi.mjs", "recovery.mjs", "shared-library.mjs", "subagents.mjs", "bridge.mjs"]) {
      await copyFile(join(sources, name), join(target, name === "supervisor.mjs" ? "transport.mjs" : name))
    }
  }
  await materialize(directory)
  const provider = join(home, "peer.mjs"), prompts = join(home, "prompts.jsonl")
  await writeFile(provider, peer, { mode: 0o600 })
  await writeFile(prompts, "", { mode: 0o600 })
  const config = { directory, executionId: "parent-execution", conversationId: "parent-conversation", cwd: home, agentId: "opencode",
    command: [process.execPath, provider, prompts], env: {}, continuity: true, create: true, sharedLibrary: true, serverSubagents: true }
  const controllers = [], transports = []
  const coordinator = (owner = () => true) => { const value = createServerSubagents(config, owner); controllers.push(value); return value }
  t.after(async () => {
    for (const controller of controllers) await controller.close()
    for (const transport of transports) transport.kill("SIGTERM")
    const agents = join(home, ".local/state/still/agents")
    for (const execution of await readdir(agents)) {
      try { const state = JSON.parse(await readFile(join(agents, execution, "state.json"), "utf8")); if (state.pid) process.kill(-state.pid, "SIGTERM") } catch {}
    }
    process.env.HOME = before
    await rm(home, { recursive: true, force: true })
  })
  return { home, directory, config, coordinator, transports, materialize, prompts: async () => (await readFile(prompts, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) }
}

// wait returns on the first real change, so callers loop until the child has settled.
async function settle(wait, childId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await wait({ action: "wait", childId, timeoutMs: 1000 })
    if (!state.turnActive && !state.queuedGuidance) return state
  }
  throw new Error("Child did not settle")
}

async function parentTransport(f) {
  const child = spawn(process.execPath, [join(f.directory, "transport.mjs"), "attach", Buffer.from(JSON.stringify(f.config)).toString("base64")], { env: { ...process.env, HOME: f.home }, stdio: ["pipe", "pipe", "pipe"] })
  f.transports.push(child)
  let buffer = "", stderr = ""
  const pending = new Map()
  child.stderr.on("data", bytes => { stderr += bytes })
  child.stdout.on("data", bytes => {
    buffer += bytes
    let end
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line), waiter = pending.get(String(frame.id))
      if (!frame.method && waiter) { pending.delete(String(frame.id)); clearTimeout(waiter.timer); frame.error ? waiter.reject(new Error(frame.error.message)) : waiter.resolve(frame.result) }
    }
  })
  let sequence = 0
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(String(id), { resolve, reject, timer: setTimeout(() => reject(new Error(stderr || "Parent handshake timed out")), 10_000) })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  await request("initialize", { protocolVersion: 1 })
  const session = await request("session/new", { cwd: f.home, mcpServers: [] })
  return { session, close: () => new Promise(resolve => { child.once("exit", resolve); child.stdin.end() }) }
}

test("authenticated parent tools prepare, choose dependent settings and guide with no desktop or phone attached", { timeout: 20000 }, async t => {
  const f = await fixture(t), parent = await parentTransport(f)
  const route = parent.session.fixtureTodoRoute
  await parent.close()
  const call = (input, requestId) => requestSubagents(route, input, requestId)
  const prepared = await call({ action: "prepare", agentId: "opencode", title: "Server child" }, "prepare")
  assert.equal(prepared.prepared, true)
  assert.deepEqual(prepared.settings.model.choices.map(choice => choice.id), ["a", "b"])
  assert.equal((await f.prompts()).length, 0)
  await call({ action: "spawn", childId: prepared.childId, title: "Server child", task: "slow task", modelId: "b", effort: "high" }, "spawn")
  const queued = await call({ action: "guide", childId: prepared.childId, message: "Follow-up from parent" }, "guide")
  assert.equal(queued.status, "Queued")
  await settle(input => call(input, "wait"), prepared.childId)
  const done = await call({ action: "inspect", childId: prepared.childId }, "inspect")
  assert.equal(done.queuedGuidance, 0)
  const log = await f.prompts()
  assert.equal(log.length, 2)
  assert.equal(log[0].model, "b")
  assert.ok(log[1].text.includes("Follow-up from parent"))
  await call({ action: "guide", childId: prepared.childId, message: "Follow-up from parent" }, "guide")
  assert.equal((await f.prompts()).length, 2, "a lost/repeated acknowledgement must not create another paid turn")
})

test("server coordination preserves queued guidance across transport/coordinator recreation", { timeout: 20000 }, async t => {
  const f = await fixture(t), first = f.coordinator()
  const prepared = await first.apply({ action: "prepare", agentId: "opencode" }, "prepare")
  await first.apply({ action: "spawn", childId: prepared.childId, title: "Durable child", task: "slow task" }, "spawn")
  await first.apply({ action: "guide", childId: prepared.childId, message: "Survive recreation" }, "guide")
  await first.close()
  const second = f.coordinator()
  await settle(input => second.apply(input, "wait"), prepared.childId)
  const after = await second.apply({ action: "inspect", childId: prepared.childId }, "inspect")
  assert.equal(after.queuedGuidance, 0)
  assert.equal((await f.prompts()).length, 2)
})

test("invalid settings cannot send a task and a parent cannot manage another parent's child", { timeout: 20000 }, async t => {
  const f = await fixture(t), parent = f.coordinator()
  await assert.rejects(parent.apply({ action: "spawn", agentId: "opencode", title: "No reserved identity", task: "Do not send" }, "unsafe-direct"), /Prepare a child first/)
  const prepared = await parent.apply({ action: "prepare", agentId: "opencode" }, "prepare")
  await assert.rejects(parent.apply({ action: "spawn", childId: prepared.childId, title: "Never sent", task: "Do not send", modelId: "made-up" }, "bad-model"), /Unsupported model/)
  await assert.rejects(parent.apply({ action: "inspect", childId: "foreign-child" }, "foreign"), /does not belong/)
  assert.equal((await f.prompts()).length, 0)
})

test("user-owned approval blocks guidance; cancellation pauses it rather than approving or restarting work", { timeout: 20000 }, async t => {
  const f = await fixture(t), parent = f.coordinator()
  const prepared = await parent.apply({ action: "prepare", agentId: "opencode" }, "prepare")
  await parent.apply({ action: "spawn", childId: prepared.childId, title: "Approval child", task: "permission task" }, "spawn")
  await parent.apply({ action: "guide", childId: prepared.childId, message: "Wait for approval" }, "guide")
  const before = await parent.apply({ action: "wait", childId: prepared.childId, timeoutMs: 1000 }, "wait")
  assert.equal(before.needsAttention, true)
  assert.equal(before.queuedGuidance, 1)
  await parent.apply({ action: "cancel", childId: prepared.childId }, "cancel")
  const after = await parent.apply({ action: "inspect", childId: prepared.childId }, "inspect")
  assert.equal(after.guidancePaused, true)
  assert.equal((await f.prompts()).length, 1)
})

test("retiring a parent coordinator cannot dispatch more child work", { timeout: 20000 }, async t => {
  const f = await fixture(t)
  let owns = true
  const parent = f.coordinator(() => owns)
  const prepared = await parent.apply({ action: "prepare", agentId: "opencode" }, "prepare")
  owns = false
  await assert.rejects(parent.apply({ action: "spawn", childId: prepared.childId, title: "Do not start", task: "Must not run" }, "retired"), /no longer owns/)
  assert.equal((await f.prompts()).length, 0)
})

test("a human-created child is discovered and managed through the same parent tool lane", { timeout: 20000 }, async t => {
  const f = await fixture(t), directory = join(f.home, ".local/state/still/agents/human-execution")
  await f.materialize(directory)
  const humanConfig = { ...f.config, directory, executionId: "human-execution", conversationId: "human-child",
    parentConversationId: f.config.conversationId, serverSubagents: false, title: "Human-created child" }
  const human = await parentTransport({ ...f, directory, config: humanConfig })
  await human.close()
  const parent = f.coordinator()
  const listed = await parent.apply({ action: "list" }, "list-human")
  assert.equal(listed.children.length, 1)
  assert.equal(listed.children[0].childId, "human-child")
  await parent.apply({ action: "guide", childId: "human-child", message: "Continue from the shared parent" }, "human-guidance")
  await parent.apply({ action: "wait", childId: "human-child", timeoutMs: 1000 }, "wait-human")
  assert.equal((await f.prompts()).length, 1)
})

test("wait returns at the child's result, results are per turn without thoughts, and children get no delegation tool or title prompt", { timeout: 20000 }, async t => {
  const f = await fixture(t), parent = await parentTransport(f)
  const route = parent.session.fixtureTodoRoute
  await parent.close()
  const call = (input, requestId) => requestSubagents(route, input, requestId)
  await assert.rejects(call({ action: "spawn", agentId: "opencode", title: "Direct", task: "Do not send" }, "direct"), /childId returned by prepare/)
  const prepared = await call({ action: "prepare", agentId: "opencode", title: "Result child" }, "prepare")
  await call({ action: "spawn", childId: prepared.childId, title: "Result child", task: "fast thought task" }, "spawn")
  const started = Date.now()
  const first = await call({ action: "wait", childId: prepared.childId, timeoutMs: 15000 }, "wait-1")
  assert.ok(Date.now() - started < 5000, `wait should return at the result, took ${Date.now() - started}ms`)
  assert.equal(first.timedOut, false)
  assert.equal(first.lastResult.text, "Done", "thought chunks are not part of the result")
  assert.equal(first.lastResult.stopReason, "end_turn")
  assert.equal(first.newResult, true)
  assert.equal((await call({ action: "inspect", childId: prepared.childId }, "inspect-1")).newResult, false, "a reported result is not new again")
  await call({ action: "guide", childId: prepared.childId, message: "second turn" }, "guide")
  const second = await settle(input => call(input, "wait-2"), prepared.childId)
  assert.equal(second.lastResult.text, "Done", "the second result does not include the first turn's reply")
  assert.equal(second.lastResult.source, "parentAgent")
  const log = await f.prompts()
  assert.equal(log[0].text, "fast thought task", "a parent-titled child is not asked to retitle itself")
  assert.deepEqual(log.map(entry => entry.subagents), ["0", "0"], "child workers are launched without the delegation tool")
})

test("a long wait does not block other operations for the same parent", { timeout: 25000 }, async t => {
  const f = await fixture(t), parent = f.coordinator()
  const prepared = await parent.apply({ action: "prepare", agentId: "opencode" }, "prepare")
  await parent.apply({ action: "spawn", childId: prepared.childId, title: "Approval child", task: "permission task" }, "spawn")
  await new Promise(resolve => setTimeout(resolve, 200))
  const waitStarted = Date.now()
  const waiting = parent.apply({ action: "wait", childId: prepared.childId, timeoutMs: 15000 }, "long-wait")
  const inspectStarted = Date.now()
  const inspected = await parent.apply({ action: "inspect", childId: prepared.childId }, "inspect")
  assert.ok(Date.now() - inspectStarted < 2000, "inspect is answered while wait is pending")
  assert.equal(inspected.needsAttention, true)
  await parent.apply({ action: "cancel", childId: prepared.childId }, "cancel")
  const waited = await waiting
  assert.equal(waited.timedOut, false)
  assert.ok(Date.now() - waitStarted < 8000, "wait returns once the pending request is cancelled")
  assert.equal(waited.needsAttention, false)
})

test("receipts older than an hour are pruned instead of disabling delegation; recent ones still bound it", { timeout: 20000 }, async t => {
  const f = await fixture(t)
  const root = join(f.home, ".local/state/still/agent-children", createHash("sha256").update(f.config.conversationId).digest("hex"))
  const seed = at => writeFile(join(root, "state.json"), JSON.stringify({ version: 1, parentId: f.config.conversationId, cwd: f.config.cwd, children: {}, receipts: Array.from({ length: 512 }, (_, index) => ({ id: `old-${index}`, fingerprint: "x", result: {}, at })) }), { mode: 0o600 })
  await mkdir(root, { recursive: true, mode: 0o700 })
  await seed(0)
  const parent = f.coordinator()
  await parent.apply({ action: "prepare", agentId: "opencode" }, "after-prune")
  const saved = JSON.parse(await readFile(join(root, "state.json"), "utf8"))
  assert.equal(saved.receipts.length, 512)
  assert.equal(saved.receipts.at(-1).id, "after-prune")
  assert.ok(!saved.receipts.some(receipt => receipt.id === "old-0"), "the oldest receipt was released")
  await parent.close()
  await seed(Date.now())
  const busy = f.coordinator()
  await assert.rejects(busy.apply({ action: "prepare", agentId: "opencode" }, "too-many"), /within the last hour/)
})

test("eligibility comes from the app's verified discovery and PATH-only agents are reported unverified", { timeout: 20000 }, async t => {
  const f = await fixture(t)
  f.config.subagentAgents = [{ agentId: "codex", executable: "/opt/codex", available: false, reason: "Codex needs sign-in" }]
  const parent = f.coordinator()
  const { agents } = await parent.apply({ action: "list" }, "list")
  const byId = Object.fromEntries(agents.map(agent => [agent.agentId, agent]))
  assert.deepEqual(byId.codex, { agentId: "codex", name: "Codex", available: false, verified: true, reason: "Codex needs sign-in" })
  assert.equal(byId.opencode.verified, true, "the parent's own running agent is verified")
  assert.equal(byId.claude.verified, false)
  await assert.rejects(parent.apply({ action: "prepare", agentId: "codex" }, "prepare-codex"), /Choose an available agent/)
})

test("child transports track each pending request and keep only the agent's reply as the result", () => {
  const transport = new ChildTransport({}, () => {})
  transport.receive({ method: "_still/prompt_accepted", params: { messageId: "m1", promptId: 7, source: "user" } })
  transport.receive({ jsonrpc: "2.0", id: "a", method: "session/request_permission", params: {} })
  transport.receive({ jsonrpc: "2.0", id: "b", method: "elicitation/create", params: {} })
  transport.receive({ method: "_still/request_outcome", params: { requestId: "a" } })
  assert.equal(transport.needsAttention, true, "answering one request leaves the other pending")
  transport.receive({ method: "_still/request_outcome", params: { requestId: "b" } })
  assert.equal(transport.needsAttention, false)
  transport.receive({ method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hidden" } } } })
  transport.receive({ method: "session/update", params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } } } })
  transport.receive({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } } } })
  transport.receive({ method: "_still/turn_finished", params: { promptId: 7, stopReason: "end_turn" }, _still: { index: 12 } })
  assert.deepEqual(transport.lastResult, { promptId: 7, messageId: "m1", source: "user", text: "Answer", resultIndex: 12, stopReason: "end_turn" })
  assert.equal(transport.busy, false)
})

test("children are not offered the delegation tool and Pi call IDs become valid operation identities", () => {
  assert.ok(hostTools({}).some(tool => tool.name === "still_subagents"))
  assert.ok(!hostTools({ STILL_SUBAGENTS: "0" }).some(tool => tool.name === "still_subagents"))
  assert.match(piOperationId("call_abc123|fc_0123456789abcdef"), /^[A-Za-z0-9:_-]{1,160}$/)
  assert.notEqual(piOperationId("call_a|fc_1"), piOperationId("call_a|fc_2"))
})

test("prepare re-configures an unused child, refreshes model-dependent choices, and never creates another child", { timeout: 20000 }, async t => {
  const f = await fixture(t), parent = await parentTransport(f)
  const route = parent.session.fixtureTodoRoute
  await parent.close()
  let sequence = 0
  const call = input => requestSubagents(route, input, `reprepare-${++sequence}`)
  await assert.rejects(call({ action: "prepare" }), /agentId for a new child, or the childId/)
  const prepared = await call({ action: "prepare", agentId: "opencode" })
  assert.deepEqual(prepared.settings.effort.choices.map(choice => choice.id), ["medium"])
  const remodeled = await call({ action: "prepare", childId: prepared.childId, modelId: "b" })
  assert.equal(remodeled.childId, prepared.childId)
  assert.equal(remodeled.settings.model.current, "b")
  assert.deepEqual(remodeled.settings.effort.choices.map(choice => choice.id), ["high"], "effort choices follow the selected model")
  assert.equal(remodeled.prepared, true)
  await assert.rejects(call({ action: "prepare", childId: prepared.childId, effort: "medium" }),
    error => /Unsupported effort ID "medium" for prepared child subagent-/.test(error.message) && /Available effort \(high\)/.test(error.message) && /No task was sent/.test(error.message))
  await assert.rejects(call({ action: "prepare", childId: prepared.childId, modelId: "b", modeId: "plan" }),
    /did not keep the requested settings \(model is "a", not "b"\)\. No task was sent/, "a mode change that resets the model is caught, not assumed")
  await assert.rejects(call({ action: "prepare", childId: "foreign-child", modelId: "b" }), /does not belong/)
  const listed = await call({ action: "list" })
  assert.equal(listed.children.length, 1, "re-preparing never creates another child")
  assert.equal((await f.prompts()).length, 0, "preparing never sends a task")
  await call({ action: "spawn", childId: prepared.childId, title: "Configured child", task: "fast task", modelId: "b", modeId: "ask" })
  assert.equal((await f.prompts())[0].model, "b")
  await assert.rejects(call({ action: "prepare", childId: prepared.childId, modelId: "a" }), /already started work/)
  assert.equal((await f.prompts()).length, 1)
})

test("prepare with an agentId and settings creates and configures the child in one step", { timeout: 20000 }, async t => {
  const f = await fixture(t), parent = f.coordinator()
  const prepared = await parent.apply({ action: "prepare", agentId: "opencode", modelId: "b", effort: "high" }, "prepare-configured")
  assert.equal(prepared.settings.model.current, "b")
  assert.equal(prepared.settings.effort.current, "high")
  assert.match(prepared.note, /requested settings verified/)
  assert.equal((await f.prompts()).length, 0)
})
