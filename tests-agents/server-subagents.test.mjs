import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServerSubagents } from "../src-tauri/agent-host/subagents.mjs"
import { requestSubagents } from "../src-tauri/agent-host/todos.mjs"

const sources = fileURLToPath(new URL("../src-tauri/agent-host/", import.meta.url))
const peer = `
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
let model='a',active=null,timer=null;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const options=()=>[{id:'model',name:'Model',category:'model',type:'select',currentValue:model,options:[{value:'a',name:'A'},{value:'b',name:'B'}]}, {id:'effort',name:'Reasoning',category:'thought_level',type:'select',currentValue:model==='b'?'high':'medium',options:[{value:model==='b'?'high':'medium',name:'Available effort'}]}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
 else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture-'+process.pid,configOptions:options(),fixtureTodoRoute:{socket:process.env.STILL_TODO_SOCKET,token:process.env.STILL_TODO_TOKEN}}});
 else if(m.method==='session/set_config_option'){if(m.params.configId==='model')model=m.params.value;send({jsonrpc:'2.0',id:m.id,result:{configOptions:options()}});}
 else if(m.method==='session/prompt'){
   active=m.id;const text=m.params.prompt.map(p=>p.text||'').join('');appendFileSync(process.argv[2],JSON.stringify({text,model})+'\\n');
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
  await call({ action: "wait", childId: prepared.childId, timeoutMs: 1000 }, "wait")
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
  await second.apply({ action: "wait", childId: prepared.childId, timeoutMs: 1200 }, "wait")
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
