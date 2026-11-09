import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/session/identity.ts", import.meta.url), "utf8")
const output = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 })
const { sessionHostKey } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`)

test("legacy and explicit SSH identities keep the existing host key", () => {
  const legacy = { host: "Example.COM", port: 22, username: "dev" }
  assert.equal(sessionHostKey(legacy), JSON.stringify(["example.com", 22, "dev"]))
  assert.equal(sessionHostKey({ ...legacy, transport: "ssh" }), sessionHostKey(legacy))
})

test("local identity is stable and cannot collide with localhost SSH", () => {
  const local = { transport: "local", host: "localhost", port: 22, username: "dev" }
  assert.equal(sessionHostKey(local), JSON.stringify(["local", "this-device"]))
  assert.notEqual(sessionHostKey(local), sessionHostKey({ ...local, transport: "ssh" }))
  assert.equal(sessionHostKey({ ...local, host: "ignored", username: "other" }), sessionHostKey(local))
})
