import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"

const source = await readFile(new URL("../src/agents/transcript.ts", import.meta.url), "utf8")
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } })
const { toolSummary, shortCommand } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`)

const tool = (fields) => ({ id: "t", kind: "tool", status: "completed", ...fields })

test("commands keep only the program and its subcommands", () => {
  assert.equal(shortCommand("cd still-app && NODE_ENV=test npx playwright test -c tests-agents/playwright.config.ts --grep y"), "playwright test")
  assert.equal(shortCommand("git log --oneline | head"), "git log")
  assert.equal(shortCommand("npm run format:check"), "npm run format:check")
  assert.equal(shortCommand("/usr/bin/python3 scripts/build.py"), "python3")
  assert.equal(toolSummary(tool({ toolKind: "execute", input: { command: "npm test -- --watch" } })), "Ran npm test")
})

test("file tools name just the file", () => {
  assert.equal(toolSummary(tool({ toolKind: "read", input: { path: "/mnt/data/still/still-app/src/components/AgentTimeline.tsx" } })), "Read AgentTimeline.tsx")
  assert.equal(toolSummary(tool({ toolKind: "edit", input: { file_path: "src/file-1.ts" } })), "Edited file-1.ts")
})

test("searches quote a short pattern", () => {
  assert.equal(toolSummary(tool({ toolKind: "search", input: { pattern: "agent-activity-summary" } })), "Searched for “agent-activity-summary”")
  assert.equal(toolSummary(tool({ toolKind: "search", input: { pattern: "a very long regular expression that keeps going" } })), "Searched for “a very long regular express…”")
})

test("other tools get a humanized title", () => {
  assert.equal(toolSummary(tool({ title: "mcp__claude-in-chrome__read_page" })), "Read page")
  assert.equal(toolSummary(tool({ title: "Await build output" })), "Await build output")
  assert.equal(toolSummary(tool({})), "Used a tool")
})

test("running tools use present tense", () => {
  assert.equal(toolSummary(tool({ status: "in_progress", toolKind: "execute", input: { command: "cargo build --release" } })), "Running cargo build")
  assert.equal(toolSummary(tool({ status: "pending", toolKind: "read", input: { path: "a/b.md" } })), "Reading b.md")
})
