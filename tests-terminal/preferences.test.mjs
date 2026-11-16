import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import ts from "typescript"

const source = await readFile(new URL("../src/types/index.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
const { terminalScrollback } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

test("restored terminal preferences cannot bypass the existing scrollback range", () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, "500000000", {}]) assert.equal(terminalScrollback(value), 5000)
  assert.equal(terminalScrollback(-1), 1000)
  assert.equal(terminalScrollback(5000), 5000)
  assert.equal(terminalScrollback(8000.9), 8000)
  assert.equal(terminalScrollback(500_000_000), 50000)
})
