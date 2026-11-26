import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/bridge/errors.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } })
const { splitErrorText } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

test("OS error chains become one plain sentence with the original kept as detail", () => {
  const raw = "Cannot reach the host (failed to connect to 100.86.95.34:22: Connection refused (os error 111)). Check the hostname, port, and network."
  assert.deepEqual(splitErrorText(raw), { summary: "Cannot reach the host. Check the hostname, port, and network.", detail: raw })
})

test("stack traces keep only the first meaningful line in the summary", () => {
  const raw = "Error: spawn ENOENT /usr/local/bin/opencode\n    at ChildProcess._handle.onexit (node:internal/child_process:286:19)"
  const { summary, detail } = splitErrorText(raw)
  assert.equal(summary, "Spawn ENOENT /usr/local/bin/opencode")
  assert.equal(detail, raw)
})

test("short plain messages pass through without a details disclosure", () => {
  assert.deepEqual(splitErrorText("SSH disconnected. Submission is uncertain."), { summary: "SSH disconnected. Submission is uncertain." })
  assert.deepEqual(splitErrorText("[auth_failed] Authentication failed"), { summary: "Authentication failed" })
  assert.deepEqual(splitErrorText("Open the folder (it was moved)."), { summary: "Open the folder (it was moved)." })
})

test("long output is cut on a word boundary and empty input uses the fallback", () => {
  const raw = `Agent stderr: ${"word ".repeat(80)}`
  const { summary, detail } = splitErrorText(raw)
  assert.ok(summary.length <= 160 && summary.endsWith("…"))
  assert.equal(detail, raw.trim())
  assert.deepEqual(splitErrorText("   ", "Could not connect."), { summary: "Could not connect." })
  assert.deepEqual(splitErrorText(undefined), { summary: "Something went wrong." })
})
