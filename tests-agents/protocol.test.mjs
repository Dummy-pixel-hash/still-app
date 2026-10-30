import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises"
import { createServer } from "node:net"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createHost, frameReader, sseReader, OpenCodeDriver } from "../src-tauri/agent-host/bridge.mjs"

test("JSONL framing preserves split UTF-8 and Unicode separators", () => {
  const frames = [], errors = []
  const read = frameReader(frame => frames.push(frame), error => errors.push(error))
  const bytes = Buffer.from(JSON.stringify({ text: "Hello λ\u2028world" }) + "\r\n" + JSON.stringify({ id: 2 }) + "\n")
  for (const byte of bytes) read(Buffer.from([byte]))
  assert.deepEqual(frames, [{ text: "Hello λ\u2028world" }, { id: 2 }]); assert.equal(errors.length, 0)
})
test("SSE framing handles CRLF split across chunks", () => {
  const frames = [], errors = [], read = sseReader(frame => frames.push(frame), error => errors.push(error))
  for (const byte of Buffer.from('data: {"text":"λ"}\r\n\r\ndata: {"id":2}\n\n')) read(Buffer.from([byte]))
  assert.deepEqual(frames, [{ text: "λ" }, { id: 2 }]); assert.equal(errors.length, 0)
})
test("invalid JSON and oversized frames fail explicitly", () => {
  const errors = [], read = frameReader(() => {}, error => errors.push(error))
  read(Buffer.from("{broken}\n")); read(Buffer.from("x".repeat(2 * 1024 * 1024 + 1)))
  assert.equal(errors.length, 2)
})
test("MCP todo tool exposes the shared revision contract and returns structured snapshots", async () => {
  if (process.platform === "win32") return
  const dir = await mkdtemp("/tmp/opencode/still-todo-mcp-")
  const socketPath = `${dir}/todo.sock`, token = randomBytes(32).toString("hex")
  const state = { protocolVersion:3, revision: 4, items: [{ id:"task-1",title:"Verify the worker",status:"pending",createdBy:"agent",updatedBy:"agent" }], toolAvailable:true, available:true }
  const server = createServer(socket => {
    let buffer = ""
    socket.on("data", chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end + 1)
        const response = request.params?.token === token
          ? { jsonrpc:"2.0", id:request.id, result:{ todos:state } }
          : { jsonrpc:"2.0", id:request.id, error:{ code:-32000, message:"Unauthorized" } }
        socket.write(JSON.stringify(response)+"\n")
      }
    })
  })
  const child = spawn(process.execPath,[fileURLToPath(new URL("../src-tauri/agent-host/todos.mjs",import.meta.url)),"mcp"],{env:{...process.env,STILL_TODO_SOCKET:socketPath,STILL_TODO_TOKEN:token},stdio:["pipe","pipe","pipe"]})
  let buffer="", stderr=""
  const replies = new Map(), waiters = new Map()
  child.stderr.on("data",chunk=>{stderr+=chunk.toString()})
  child.stdout.on("data",chunk=>{
    buffer+=chunk
    let end
    while((end=buffer.indexOf("\n"))>=0){
      const frame=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1)
      const waiter=waiters.get(String(frame.id))
      if(waiter){clearTimeout(waiter.timer);waiters.delete(String(frame.id));waiter.resolve(frame)}else replies.set(String(frame.id),frame)
    }
  })
  const send=message=>new Promise((resolve,reject)=>{
    const key=String(message.id)
    if(replies.has(key)){resolve(replies.get(key));replies.delete(key);return}
    const timer=setTimeout(()=>{waiters.delete(key);reject(new Error(`MCP reply timeout: ${stderr}`))},4000)
    waiters.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify(message)+"\n")
  })
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(socketPath,resolve)})
  try {
    const init=await send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"fixture",version:"1"}}})
    assert.equal(init.result.serverInfo.name,"still-todos")
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n")
    const tools=await send({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})
    assert.equal(tools.result.tools[0].name,"still_todos")
    assert.equal(tools.result.tools[0].inputSchema.properties.action.enum[0],"list")
    assert.ok(tools.result.tools[0].inputSchema.properties.action.enum.includes("focus"))
    const result=await send({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"still_todos",arguments:{action:"list"}}})
    assert.deepEqual(result.result.structuredContent,state)
    assert.equal(JSON.parse(result.result.content[0].text).items[0].title,"Verify the worker")
  } finally {
    child.stdin.end(); await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once("exit",resolve);setTimeout(()=>{child.kill("SIGTERM")},500).unref()})
    server.close(); await unlink(socketPath).catch(()=>{}); await rm(dir,{recursive:true,force:true})
  }
})
test("OpenCode command completion does not discard an outstanding form", async () => {
  const driver = new OpenCodeDriver({ update: () => {} }, "not-spawned")
  driver.id = "fixture"; driver.commandIdleCheck = true
  let forms = [{ id: "question", state: { type: "pending" } }]
  driver.http = async (_method, path) => path.endsWith("/form") ? { data: forms } : { data: {} }
  const done = driver.begin()
  await driver.checkCommandIdle()
  assert.ok(driver.turn, "form must keep the command alive")
  forms = []
  driver.questionCount = 1
  await driver.checkCommandIdle()
  assert.ok(driver.turn, "an unanswered forwarded question must keep the command alive")
  driver.questionCount = 0
  await driver.checkCommandIdle()
  assert.equal((await done).stopReason, "end_turn")
})

test("OpenCode discovery includes nested commands and skills without creating a session", async () => {
  if (process.platform === "win32") return
  const dir = await mkdtemp("/tmp/opencode/still-discovery-")
  const executable = `${dir}/opencode`
  await writeFile(executable, `#!/bin/sh\nexec env STILL_TEST_PEER=opencode ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("./protocol-peer.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700 })
  const driver = new OpenCodeDriver({ update() {} }, executable)
  const calls = [], http = driver.http.bind(driver)
  driver.http = async (method, path, body) => { calls.push({ method, path }); return http(method, path, body) }
  try {
    const catalog = await driver.discover()
    assert.ok(catalog.commands.some(command => command.name === "team/command-23"))
    assert.ok(catalog.commands.some(command => command.name === "skill:team/review"))
    assert.equal(driver.id, "")
    assert.equal(calls.filter(call => call.method === "POST" && call.path === "/api/session").length, 0)
    assert.equal(catalog.warning, undefined)
  } finally { await driver.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const provider of ["pi", "claude", "codex", "opencode"]) test(`native ${provider} driver: startup, commands, two turns, tool/approval translation`, async () => {
  if (process.platform === "win32") return // Remote runners target POSIX SSH hosts; wrapper fixture uses /bin/sh.
  const dir = await mkdtemp("/tmp/opencode/still-protocol-")
  const executable = `${dir}/${provider}`
  await writeFile(executable, `#!/bin/sh\nexec env STILL_TEST_PEER=${provider} ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("./protocol-peer.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700 })
  const frames = []
  let host
  host = createHost(frame => {
    frames.push(frame)
    if (frame.method === "session/request_permission") queueMicrotask(() => void host.handle({ id: frame.id, result: { outcome: { outcome: "selected", optionId: provider === "codex" ? "accept" : "allow" } } }))
  }, provider, executable)
  try {
    await host.handle({ id: 1, method: "initialize" })
    await host.handle({ id: 2, method: "session/new" })
    const ready = frames.find(frame => frame.id === 2)
    assert.equal(ready.error, undefined); assert.ok(ready.result.sessionId); assert.ok(ready.result.configOptions.length)
    assert.deepEqual(ready.result._meta.historyCapabilities, { revert: provider !== "claude", retry: provider !== "claude" })
    const commands = frames.filter(frame => frame.params?.update?.sessionUpdate === "available_commands_update").at(-1).params.update.availableCommands
    if (provider === "opencode") {
      assert.equal(commands.filter(command => command.route === "command").length, 24)
      assert.ok(commands.some(command => command.name === "skill:team/review" && command.route === "skill"))
      assert.ok(commands.some(command => command.name === "reload"))
    }
    for (const id of [3, 4]) {
      await host.handle({ id, method: "session/prompt", params: { prompt: [{ type: "text", text: provider === "opencode" ? "/team/command-23 arguments" : "Hello" }] } })
      assert.equal(frames.find(frame => frame.id === id).result?.stopReason, "end_turn")
    }
    const updates = frames.flatMap(frame => frame.params?.update ? [frame.params.update] : [])
    assert.ok(updates.some(update => update.content?.text?.includes(provider === "opencode" ? "arguments" : "Hello")))
    if (provider !== "opencode") {
      assert.ok(updates.some(update => update.toolCallId === "call-1" && update.status === "completed"))
      assert.ok(updates.some(update => update.rawInput?.command === "npm test"))
    }
    if (provider === "claude" || provider === "codex") assert.equal(frames.filter(frame => frame.method === "session/request_permission").length, 2)
    for (const id of [5, 7]) {
      const boundary = frames.length
      const turn = host.handle({ id, method: "session/prompt", params: { prompt: [{ type: "text", text: "WAIT" }] } })
      // Synchronise against prompt admission/output, not a fixed sleep.
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000
        const check = () => {
          const live = frames.slice(boundary).some(frame => frame.params?.update?.content?.text === "WAIT_ADMITTED")
          if (live) { setImmediate(resolve); return }
          if (Date.now() > deadline) { reject(new Error("fixture prompt was not admitted")); return }
          setImmediate(check)
        }
        setImmediate(check)
      })
      await host.handle({ id: id + 1, method: "session/cancel" })
      await turn
      assert.equal(frames.find(frame => frame.id === id).result?.stopReason, "cancelled")
    }
    if (provider !== "claude") {
      await host.handle({ id: 9, method: "session/prompt", params: { prompt: [{ type: "text", text: "/compact" }] } })
      assert.equal(frames.find(frame => frame.id === 9).result?.stopReason, "end_turn")
    }
    if (provider === "opencode") {
      await host.handle({ id: 10, method: "session/prompt", params: { prompt: [{ type: "text", text: "@team/review Inspect arguments" }] } })
      assert.equal(frames.find(frame => frame.id === 10).result?.stopReason, "end_turn")
      assert.ok(frames.some(frame => frame.params?.update?.content?.text === "Attached skill: team/review. @team/review Inspect arguments"))
      await host.handle({ id: 11, method: "session/prompt", params: { prompt: [{ type: "text", text: "/reload" }] } })
      assert.equal(frames.find(frame => frame.id === 11).result?.stopReason, "end_turn")
    }
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const provider of ["pi", "codex", "opencode"]) test(`${provider} history uses provider checkpoints and rejects stale or declined boundaries`, async () => {
  if (process.platform === "win32") return
  const dir = await mkdtemp("/tmp/opencode/still-history-protocol-")
  const executable = `${dir}/${provider}`
  await writeFile(executable, `#!/bin/sh\nexec env STILL_TEST_PEER=${provider} ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("./protocol-peer.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700 })
  const frames = []
  let host
  host = createHost(frame => {
    frames.push(frame)
    if (frame.method === "session/request_permission") queueMicrotask(() => void host.handle({ id: frame.id, result: { outcome: { outcome: "selected", optionId: "accept" } } }))
  }, provider, executable)
  try {
    await host.handle({ id: 1, method: "initialize" })
    await host.handle({ id: 2, method: "session/new" })
    let sessionId = frames.find(frame => frame.id === 2).result.sessionId
    for (const [id, text] of [[3, "First request"], [4, "Second request"]]) {
      await host.handle({ id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }], _meta: { messageId: `local-${id}` } } })
      assert.equal(frames.find(frame => frame.id === id).result.stopReason, "end_turn")
    }
    const checkpoints = frames.flatMap(frame => frame.params?.update?.sessionUpdate === "still_message_checkpoint" ? [frame.params.update] : [])
    assert.equal(checkpoints.length, 2)
    assert.equal(checkpoints[1].messageId, "local-4")
    await host.handle({ id: 5, method: "_still/session/revert", params: { sessionId, checkpoint: checkpoints[1].checkpoint } })
    const reverted = frames.find(frame => frame.id === 5)
    assert.equal(reverted.error, undefined)
    assert.equal(reverted.result.reverted, true)
    sessionId = reverted.result.sessionId
    await host.handle({ id: 6, method: "_still/session/revert", params: { sessionId, checkpoint: checkpoints[1].checkpoint } })
    assert.ok(frames.find(frame => frame.id === 6).error, "removed messages cannot be reverted again")
    await host.handle({ id: 7, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Second request" }], _meta: { messageId: "local-retry" } } })
    assert.equal(frames.find(frame => frame.id === 7).result.stopReason, "end_turn")
    await host.handle({ id: 8, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "REJECT_REVERT" }], _meta: { messageId: "local-rejected" } } })
    const rejectedCheckpoint = frames.find(frame => frame.params?.update?.messageId === "local-rejected").params.update.checkpoint
    await host.handle({ id: 9, method: "_still/session/revert", params: { sessionId, checkpoint: rejectedCheckpoint } })
    assert.ok(frames.find(frame => frame.id === 9).error)
    assert.notEqual(frames.find(frame => frame.id === 9).error.data?.historyUncertain, true)
    await host.handle({ id: 10, method: "_still/session/revert", params: { sessionId, checkpoint: checkpoints[0].checkpoint } })
    assert.equal(frames.find(frame => frame.id === 10).result?.reverted, true, "earlier provider checkpoints remain usable after the retry")
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
})

for (const provider of ["pi", "codex", "opencode"]) test(`${provider} keeps history actions unavailable when the required protocol is absent`, async () => {
  if (process.platform === "win32") return
  const dir = await mkdtemp("/tmp/opencode/still-no-history-")
  const executable = `${dir}/${provider}`
  await writeFile(executable, `#!/bin/sh\nexec env STILL_TEST_PEER=${provider} STILL_TEST_NO_HISTORY=1 ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("./protocol-peer.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700 })
  const frames = [], host = createHost(frame => frames.push(frame), provider, executable)
  try {
    await host.handle({ id: 1, method: "initialize" })
    await host.handle({ id: 2, method: "session/new" })
    const result = frames.find(frame => frame.id === 2).result
    assert.deepEqual(result._meta.historyCapabilities, { revert: false, retry: false })
    await host.handle({ id: 3, method: "_still/session/revert", params: { sessionId: result.sessionId, checkpoint: {} } })
    assert.match(frames.find(frame => frame.id === 3).error.message, /does not support/)
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
})
