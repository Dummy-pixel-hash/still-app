import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8")
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } })
  const code = outputText.replace('from "diff"', `from ${JSON.stringify(import.meta.resolve("diff"))}`)
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)
}
const { conversation } = await load("../src/agents/transcript.ts")
const { conversationChanges, changeTotals } = await load("../src/agents/changes.ts")
const patch = { type: "diff", path: "src/main.ts", oldText: "const before = 1;\n", newText: "const after = 2;\n" }
const tool = { sequence: 1, attemptId: "execution-a", type: "toolStart", toolCallId: "edit-1", title: "Edit", toolKind: "edit", content: [patch] }

test("a completion containing only tool output cannot erase an earlier supplied edit", () => {
  const items = conversation([tool, { sequence: 2, attemptId: "execution-a", type: "toolUpdate", toolCallId: "edit-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "Successfully replaced text" } }] }])
  const changes = conversationChanges(items)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, "src/main.ts")
  assert.equal(changes[0].outcome, "completed")
  assert.equal(changeTotals(changes).files, 1)
})

test("a completion with an empty patch placeholder preserves the actual earlier preview", () => {
  const items = conversation([tool, { sequence: 2, attemptId: "execution-a", type: "toolUpdate", toolCallId: "edit-1", status: "completed", content: [{ type: "patch", path: patch.path, patch: "" }] }])
  assert.equal(conversationChanges(items)[0]?.source.newText, patch.newText)
})

for (const input of [
  { file_path: "src/edit.ts", old_string: "before\n", new_string: "after\n" },
  { filePath: "src/edit.ts", oldString: "before\n", newString: "after\n" },
  { path: "src/edit.ts", oldText: "before\n", newText: "after\n" },
]) test(`edit inputs retain a labelled snippet preview (${Object.keys(input).join(", ")})`, () => {
  const items = conversation([{ ...tool, content: undefined, rawInput: input }, { sequence: 2, attemptId: "execution-a", type: "toolUpdate", toolCallId: "edit-1", status: "completed", rawOutput: { message: "done" } }])
  const changes = conversationChanges(items)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, "src/edit.ts")
  assert.equal(changes[0].preview, "snippet")
  assert.ok(changes[0].patch.includes("after"))
})

test("failed, pending, and write-only tools do not invent successful whole-file diffs", () => {
  const failed = conversationChanges([{ id: "fail", kind: "tool", text: "", title: "Edit", toolKind: "edit", status: "failed", input: { path: "failed.ts", oldText: "a", newText: "b" } }])
  assert.equal(failed[0]?.outcome, "failed")
  assert.equal(changeTotals(failed).files, 0)
  const written = conversationChanges([{ id: "write", kind: "tool", text: "", title: "Write", toolKind: "edit", status: "completed", input: { file_path: "written.ts", content: "not necessarily a new file\n" } }])
  assert.equal(written[0]?.preview, "written")
  assert.equal(written[0]?.additions, null)
  assert.equal(written[0]?.deletions, null)
  const read = conversationChanges([{ id: "read", kind: "tool", text: "", title: "Read", toolKind: "read", status: "completed", input: { path: "read.ts", oldText: "a", newText: "b" } }])
  assert.equal(read.length, 0)
})

test("authoritative structured patches beat input snippets and newer patches replace earlier versions", () => {
  const input = { path: "src/main.ts", oldText: "x", newText: "y" }
  const next = { ...patch, newText: "const final = 3;\n" }
  const changes = conversationChanges(conversation([{ ...tool, rawInput: input }, { ...tool, sequence: 2, type: "toolUpdate", status: "completed", content: [next] }]))
  assert.equal(changes.length, 1)
  assert.equal(changes[0].source.newText, next.newText)
  assert.notEqual(changes[0].preview, "snippet")
})

test("a malformed preview cannot hide the other files in the conversation", () => {
  const content = [{ type: "diff", path: "broken.ts", newText: null }, patch]
  const changes = conversationChanges(conversation([{ ...tool, content, status: "completed" }]))
  assert.equal(changes.some(change => change.path === "src/main.ts"), true)
})

test("tool ID reuse in a different turn or execution never merges unrelated edits", () => {
  const changes = conversationChanges(conversation([
    { ...tool, status: "completed" },
    { sequence: 2, attemptId: "execution-a", type: "userMessage", text: "Next turn" },
    { ...tool, sequence: 3, status: "completed", content: [{ ...patch, path: "src/next.ts" }] },
    { ...tool, attemptId: "execution-b", status: "completed", content: [{ ...patch, path: "src/resumed.ts" }] },
  ]))
  assert.deepEqual(changes.map(change => change.path), ["src/main.ts", "src/next.ts", "src/resumed.ts"])
})

test("patch-only tools get file identities from supplied headers, not a separate input path", () => {
  const patch = "diff --git a/src/patch.ts b/src/patch.ts\n--- a/src/patch.ts\n+++ b/src/patch.ts\n@@ -1 +1 @@\n-before\n+after\n"
  for (const payload of [{ input: { patch } }, { output: { diff: patch } }]) {
    const changes = conversationChanges([{ id: "patch-only", kind: "tool", text: "", title: "apply_patch", toolKind: "edit", status: "completed", ...payload }])
    assert.equal(changes[0]?.path, "src/patch.ts")
    assert.equal(changes[0]?.additions, 1)
  }
})

test("provider-specific apply_patch blocks stay inspectable without inventing unified line numbers", () => {
  const patchText = "*** Begin Patch\n*** Update File: src/one.ts\n@@\n-before\n+after\n*** Add File: src/two.ts\n+new file\n*** End Patch"
  const changes = conversationChanges([{ id: "patch-specific", kind: "tool", text: "", title: "apply_patch", toolKind: "edit", status: "completed", input: { patchText } }])
  assert.deepEqual(changes.map(change => change.path), ["src/one.ts", "src/two.ts"])
  assert.equal(changes[0].hunks, null)
  assert.equal(changes[0].additions, null)
  assert.equal(changes[1].patch.includes("new file"), true)
})

test("unrelated streaming does not regenerate an unchanged edit-input diff", () => {
  const input = { path: "src/cached.ts", oldText: "before", newText: "after" }
  const events = [{ ...tool, content: undefined, rawInput: input, status: "completed" }]
  const first = conversationChanges(conversation(events))
  const second = conversationChanges(conversation([...events, { type: "assistantChunk", sequence: 2, attemptId: "execution-a", text: "Still checking" }]))
  assert.equal(first[0].source, second[0].source, "the before/after diff stays memoized across streaming projections")
})

test("partial completion input keeps the before text and supplied snippets beat non-unified output", () => {
  const events = [
    { ...tool, content: undefined, rawInput: { path: "src/partial.ts", oldText: "before" } },
    { ...tool, sequence: 2, type: "toolUpdate", content: undefined, status: "completed", rawInput: { newText: "after" }, rawOutput: { diff: "  1 before\n+ 1 after" } },
  ]
  const changes = conversationChanges(conversation(events))
  assert.equal(changes.length, 1)
  assert.equal(changes[0].preview, "snippet")
  assert.equal(changes[0].source.oldText, "before")
  assert.equal(changes[0].source.newText, "after")
})
