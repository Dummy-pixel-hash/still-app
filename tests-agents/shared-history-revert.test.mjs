import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("../src-tauri/agent-host/shared-library.mjs", import.meta.url)), "utf8")

test("shared history rewind advances generation idempotently and rejects wrong session", () => {
  const home = mkdtempSync(join(tmpdir(), "still-revert-test-"))
  try {
    const id = "revert-worker", conversation = "shared-conversation", session = "forked-session"
    const directory = join(home, ".local/state/still/agents", id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, "state.json"), JSON.stringify({ version: 4, executionId: id, conversationId: conversation,
      cwd: "/srv/project", agentId: "pi", ended: false, closed: false, eventIndex: 5,
      sessionResult: { sessionId: session }, historyCapabilities: { revert: true, retry: true } }), { mode: 0o600 })
    const call = input => {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, "shared-call"], { env: { ...process.env, HOME: home }, input: JSON.stringify(input), encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      return JSON.parse(result.stdout.split("\n").find(line => line.startsWith("STILL_SHARED:"))?.slice("STILL_SHARED:".length) || "null")
    }
    call({ method: "project.register", cwd: "/srv/project" })
    const first = call({ method: "recordHistoryRevert", executionId: id, messageId: "original-message", sessionId: session })
    const second = call({ method: "recordHistoryRevert", executionId: id, messageId: "original-message", sessionId: session })
    assert.equal(first.generation, 2)
    assert.equal(second.generation, 2)
    const bad = spawnSync(process.execPath, ["--input-type=module", "-e", source, "shared-call"], { env: { ...process.env, HOME: home }, input: JSON.stringify({ method: "recordHistoryRevert", executionId: id, messageId: "original-message", sessionId: "other-session" }), encoding: "utf8" })
    assert.notEqual(bad.status, 0)
    const page = call({ method: "list", options: {} })
    const row = page.rows.find(row => row.conversationId === conversation)
    assert.equal(row.shared.generation, 2)
    assert.deepEqual(row.historyCapabilities, { revert: true, retry: true })
  } finally { rmSync(home, { recursive: true, force: true }) }
})
