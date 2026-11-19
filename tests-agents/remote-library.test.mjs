import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises"
import { join } from "node:path"
import { discoverLibrary } from "../src-tauri/agent-host/library.mjs"

test("remote account identity is stable and paginated discovery does not attach workers", async()=>{
  const home=await mkdtemp("/tmp/opencode/still-library-")
  try {
    const root=join(home,".local","state","still","agents")
    for (const id of ["execution-a","execution-b"]) {
      await mkdir(join(root,id),{recursive:true,mode:0o700})
      await writeFile(join(root,id,"state.json"),JSON.stringify({version:4,executionId:id,conversationId:`conversation-${id}`,agentId:"opencode",cwd:"/srv/project",ended:false,closed:false,sessionResult:{sessionId:"provider-original",_meta:{resumable:true}}}),{mode:0o600})
    }
    const first=discoverLibrary(home,"",1), second=discoverLibrary(home,first.next,1)
    assert.equal(first.rows.length,1)
    assert.equal(first.next,"execution-a")
    assert.equal(second.rows[0].executionId,"execution-b")
    assert.equal(second.serverAccountId,first.serverAccountId)
    assert.equal(second.next,null)
    assert.equal(first.rows[0].agentSessionId,"provider-original")
    assert.throws(()=>discoverLibrary(home,"../escape"),/Invalid remote library page/)
  } finally { await rm(home,{recursive:true,force:true}) }
})

test("remote discovery rejects symlinked or public records without following them",async()=>{
  const home=await mkdtemp("/tmp/opencode/still-library-unsafe-")
  try {
    const root=join(home,".local","state","still","agents","unsafe")
    await mkdir(root,{recursive:true,mode:0o700})
    await writeFile(join(home,"private.json"),JSON.stringify({version:4,executionId:"unsafe",conversationId:"foreign",cwd:"/srv/project",agentId:"opencode"}),{mode:0o600})
    await symlink(join(home,"private.json"),join(root,"state.json"))
    const page=discoverLibrary(home)
    assert.equal(page.rows.length,0)
    assert.equal(page.warnings.length,1)
  }finally {await rm(home,{recursive:true,force:true})}
})

test("discovery refuses a writable execution parent even when its records are private", async () => {
  const home = await mkdtemp("/tmp/opencode/still-library-parent-")
  try {
    const agents = join(home, ".local", "state", "still", "agents")
    await mkdir(agents, { recursive: true, mode: 0o700 })
    await chmod(agents, 0o777)
    assert.throws(() => discoverLibrary(home), /Unsafe remote execution directory/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("uncommitted startup directories are not broken conversations and remain untouched", async t => {
  const home = await mkdtemp("/tmp/opencode/still-library-startup-")
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, ".local/state/still/agents")
  const ids = Array.from({ length: 6 }, (_, index) => `startup-${index}`)
  for (const id of ids) {
    await mkdir(join(root, id), { recursive: true, mode: 0o700 })
    await writeFile(join(root, id, "transport.mjs"), "// Reserved startup source; not a committed worker", { mode: 0o600 })
  }
  const first = discoverLibrary(home, "", 2)
  assert.deepEqual(first.rows, [])
  assert.deepEqual(first.warnings, [])
  assert.deepEqual(first.incompleteExecutions, ids.slice(0, 2))
  assert.equal(first.next, "startup-1", "pagination must advance even when a page contains only incomplete starts")
  for (const id of ids) {
    assert.equal(await readFile(join(root, id, "transport.mjs"), "utf8"), "// Reserved startup source; not a committed worker")
    await assert.rejects(stat(join(root, id, "state.json")), { code: "ENOENT" })
  }
  await writeFile(join(root, ids[0], "state.json"), JSON.stringify({ version: 4, executionId: ids[0], conversationId: "committed-conversation", agentId: "opencode", cwd: "/srv/project" }), { mode: 0o600 })
  const ready = discoverLibrary(home)
  assert.equal(ready.rows[0].conversationId, "committed-conversation")
  assert.deepEqual(ready.incompleteExecutions, ids.slice(1))
  assert.deepEqual(ready.warnings, [])
})

test("a dangling state symlink and a corrupt state record remain warnings, not incomplete starts", async t => {
  const home = await mkdtemp("/tmp/opencode/still-library-invalid-state-")
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, ".local/state/still/agents")
  for (const id of ["dangling", "corrupt"]) await mkdir(join(root, id), { recursive: true, mode: 0o700 })
  await symlink(join(home, "nonexistent.json"), join(root, "dangling/state.json"))
  await writeFile(join(root, "corrupt/state.json"), "{invalid", { mode: 0o600 })
  const page = discoverLibrary(home)
  assert.equal(page.warnings.length, 2)
  assert.deepEqual(page.incompleteExecutions, [])
})
