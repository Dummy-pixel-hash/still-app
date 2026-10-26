import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
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
    const commands = frames.filter(frame => frame.params?.update?.sessionUpdate === "available_commands_update").at(-1).params.update.availableCommands
    if (provider === "opencode") assert.equal(commands.length, 25) // waits for the cold project scan
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
  } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
})
