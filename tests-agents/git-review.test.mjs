import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectGit, parseNumstatZ, parsePorcelainV2 } from "../src-tauri/agent-host/git-review.mjs"

const oid = "e".repeat(40)
const empty = "0".repeat(40)
const statusPrefix = `1 M. N... 100644 100644 100644 ${oid} ${oid} `

async function gitFixture(name) {
  const temporary = await mkdtemp(join(tmpdir(), `still-git-${name}-`))
  const directory = join(temporary, "repo"), templates = join(temporary, "empty-template"), hooks = join(temporary, "empty-hooks")
  await mkdir(directory); await mkdir(templates); await mkdir(hooks)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  const run = (...args) => spawnSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], { cwd: directory, env, encoding: null })
  const git = (...args) => {
    const result = run(...args)
    assert.equal(result.status, 0, result.stderr?.toString("utf8"))
    return result.stdout
  }
  git("init", "-q", `--template=${templates}`)
  git("config", "user.name", "Still fixture")
  git("config", "user.email", "still-fixture@example.invalid")
  git("config", "commit.gpgsign", "false")
  return { temporary, directory, git, run, cleanup: () => rm(temporary, { recursive: true, force: true }) }
}

test("porcelain-v2 byte parser keeps branch metadata and exact staged/worktree status", () => {
  // NUL-delimited status records include real tabs/newlines in paths; no line splitting.
  const path = Buffer.from("tab\tnewline\nquote' and ;$()", "utf8")
  const bytes = Buffer.concat([
    Buffer.from(`# branch.oid ${oid}\0# branch.head feature/read-only\0# branch.upstream origin/feature/read-only\0# branch.ab +2 -1\0`),
    Buffer.from(statusPrefix), path, Buffer.from([0]),
    Buffer.from(`1 AD N... 100644 100644 000000 ${oid} ${oid} staged-then-removed\0`),
  ])
  const parsed = parsePorcelainV2(bytes)
  assert.deepEqual(parsed.branch, {
    headOid: oid, branch: "feature/read-only", upstream: "origin/feature/read-only",
    ahead: 2, behind: 1, detached: false, unborn: false,
  })
  assert.equal(parsed.truncated, false)
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0].path, "tab\\x09newline\\x0Aquote' and ;$()")
  assert.equal(parsed.entries[0].pathBytesBase64, path.toString("base64"))
  assert.deepEqual([parsed.entries[0].indexStatus, parsed.entries[0].worktreeStatus, parsed.entries[0].kind], ["M", ".", "modified"])
  assert.deepEqual([parsed.entries[1].indexStatus, parsed.entries[1].worktreeStatus, parsed.entries[1].kind], ["A", "D", "deleted"])
})

test("porcelain-v2 two-path records preserve Git's destination/source rename and copy bytes", () => {
  const newName = Buffer.from("new name with spaces.txt")
  const oldName = Buffer.from("old name\nwith newline.txt")
  const copyName = Buffer.from("copy;$destination")
  const sourceName = Buffer.from("source file")
  const bytes = Buffer.concat([
    Buffer.from(`# branch.oid ${oid}\0# branch.head feature\0`),
    Buffer.from(`2 R. N... 100644 100644 100644 ${oid} ${oid} R087 `), newName, Buffer.from([0]), oldName, Buffer.from([0]),
    Buffer.from(`2 C. N... 100644 100644 100644 ${oid} ${oid} C100 `), copyName, Buffer.from([0]), sourceName, Buffer.from([0]),
  ])
  const { entries, truncated } = parsePorcelainV2(bytes)
  assert.equal(truncated, false)
  assert.equal(entries.length, 2)
  assert.deepEqual([entries[0].kind, entries[0].path, entries[0].originalPath], ["renamed", "new name with spaces.txt", "old name\\x0Awith newline.txt"])
  assert.equal(entries[0].pathBytesBase64, newName.toString("base64"))
  assert.equal(entries[0].originalPathBytesBase64, oldName.toString("base64"))
  assert.deepEqual([entries[1].kind, entries[1].path, entries[1].originalPath], ["copied", "copy;$destination", "source file"])
})

test("porcelain-v2 retains conflicts, submodules, leading dashes and invalid UTF-8 as escaped labels", () => {
  const invalidPath = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x6e, 0x61, 0x6d, 0x65])
  const bytes = Buffer.concat([
    Buffer.from(`# branch.oid ${oid}\0# branch.head main\0`),
    Buffer.from(`u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${empty} conflict\nfile\0`),
    Buffer.from(`1 .M S..U 160000 160000 160000 ${oid} ${oid} module/path\0`),
    Buffer.from("? --leading ;$name\0"),
    Buffer.from(statusPrefix), invalidPath, Buffer.from([0]),
    Buffer.from("! ignored path\0"),
  ])
  const { entries, truncated } = parsePorcelainV2(bytes)
  assert.equal(truncated, false)
  assert.deepEqual(entries.map(entry => entry.kind), ["conflicted", "submodule", "untracked", "modified"])
  assert.equal(entries[0].path, "conflict\\x0Afile")
  assert.equal(entries[1].path, "module/path")
  assert.equal(entries[2].path, "--leading ;$name")
  assert.equal(entries[3].path, "\\x62\\x61\\x64\\xFF\\x6E\\x61\\x6D\\x65")
  assert.equal(entries[3].pathBytesBase64, invalidPath.toString("base64"))
})

test("unborn and detached branch headers remain explicit without inventing a branch", () => {
  const unborn = parsePorcelainV2(Buffer.from("# branch.oid (initial)\0# branch.head new-topic\0"))
  assert.deepEqual(unborn.branch, { headOid: null, branch: "new-topic", upstream: null, ahead: null, behind: null, detached: false, unborn: true })
  const detached = parsePorcelainV2(Buffer.from(`# branch.oid ${oid}\0# branch.head (detached)\0`))
  assert.deepEqual(detached.branch, { headOid: oid, branch: null, upstream: null, ahead: null, behind: null, detached: true, unborn: false })
  const sha256 = parsePorcelainV2(Buffer.from(`# branch.oid ${"a".repeat(64)}\0# branch.head sha256\0`))
  assert.equal(sha256.branch.headOid, "a".repeat(64))
})

test("porcelain-v2 truncation stops on complete record boundaries and never implies clean status", () => {
  const headers = Buffer.from(`# branch.oid ${oid}\0# branch.head main\0`)
  const first = Buffer.concat([headers, Buffer.from(`${statusPrefix}first file\0`)])
  const second = Buffer.from(`${statusPrefix}second file\0`)
  const incomplete = Buffer.concat([first, Buffer.from(`${statusPrefix}partial`)]).subarray(0, first.length + statusPrefix.length + 3)
  const partial = parsePorcelainV2(incomplete)
  assert.equal(partial.entries.length, 1)
  assert.equal(partial.entries[0].path, "first file")
  assert.equal(partial.truncated, true)
  const byteBounded = parsePorcelainV2(Buffer.concat([first, second]), { maxBytes: first.length + 2 })
  assert.equal(byteBounded.entries.length, 1)
  assert.equal(byteBounded.entries[0].path, "first file")
  assert.equal(byteBounded.truncated, true)
  const entryBounded = parsePorcelainV2(Buffer.concat([first, second]), { maxEntries: 1 })
  assert.equal(entryBounded.entries.length, 1)
  assert.equal(entryBounded.truncated, true)
})

test("numstat parses text, binary, rename pairs and opaque path bytes", () => {
  const invalidPath = Buffer.from([0x66, 0x69, 0x6c, 0x65, 0xfe])
  const bytes = Buffer.concat([
    Buffer.from("3\t1\tspace and\ttab.txt\0-\t-\tbinary.png\0"),
    Buffer.from("1\t0\t\0old name\0new name\0"),
    Buffer.from("0\t2\t"), invalidPath, Buffer.from([0]),
  ])
  const { entries, truncated } = parseNumstatZ(bytes)
  assert.equal(truncated, false)
  assert.deepEqual(entries.slice(0, 2).map(({ additions, deletions, binary }) => ({ additions, deletions, binary })), [
    { additions: 3, deletions: 1, binary: false }, { additions: null, deletions: null, binary: true },
  ])
  assert.equal(entries[0].path, "space and\\x09tab.txt")
  assert.deepEqual([entries[2].path, entries[2].originalPath, entries[2].additions, entries[2].deletions], ["new name", "old name", 1, 0])
  assert.deepEqual([entries[3].path, entries[3].pathBytesBase64, entries[3].binary], ["\\x66\\x69\\x6C\\x65\\xFE", invalidPath.toString("base64"), false])
})

test("numstat truncation and malformed records are explicit", () => {
  const first = Buffer.from("1\t0\tfirst\0")
  const partial = Buffer.from("2\t1\tsecond")
  assert.deepEqual(parseNumstatZ(Buffer.concat([first, partial])), {
    entries: [parseNumstatZ(first).entries[0]], truncated: true,
  })
  const bounded = parseNumstatZ(Buffer.concat([first, Buffer.from("3\t0\tsecond\0")]), { maxBytes: first.length + 2 })
  assert.equal(bounded.entries.length, 1)
  assert.equal(bounded.truncated, true)
  assert.throws(() => parsePorcelainV2(Buffer.from("1 MZ N... 100644 100644 100644 a b bad\0")), /Malformed Git status output/)
  assert.throws(() => parsePorcelainV2(Buffer.from("1 M. N... 100644 100644 100644 bad bad path\0")), /Malformed Git status output/)
  assert.throws(() => parsePorcelainV2(Buffer.alloc(0)), /Malformed Git status output/, "an empty command response is not a clean repository")
  assert.throws(() => parseNumstatZ(Buffer.from("-\t2\tbad\0")), /Malformed Git numstat output/)
  assert.throws(() => parsePorcelainV2(Buffer.alloc(0), { maxBytes: 0 }), RangeError)
})

test("parsers accept unmodified byte output from a private real Git worktree", {
  skip: process.platform === "win32" || spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "still-git-parser-"))
  const templates = join(directory, "empty-template"), hooks = join(directory, "empty-hooks")
  await mkdir(templates); await mkdir(hooks)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  const git = (...args) => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], { cwd: directory, env, encoding: null })
    assert.equal(result.status, 0, result.stderr?.toString("utf8"))
    return result.stdout
  }
  try {
    git("init", "-q", `--template=${templates}`)
    git("config", "user.name", "Still fixture")
    git("config", "user.email", "still-fixture@example.invalid")
    git("config", "commit.gpgsign", "false")
    const oldPath = "old name\nfile.txt", newPath = "new name\nfile.txt"
    await writeFile(join(directory, oldPath), "one\ntwo\n")
    await writeFile(join(directory, "split.txt"), "base version\n")
    git("add", "--", oldPath, "split.txt")
    git("commit", "-qm", "parser fixture")
    await rename(join(directory, oldPath), join(directory, newPath))
    await writeFile(join(directory, newPath), "one\ntwo\nthree\n")
    await writeFile(join(directory, "split.txt"), "staged version\n")
    await writeFile(join(directory, "binary fixture.bin"), Buffer.from([0, 1, 2, 255]))
    git("add", "-A")
    await writeFile(join(directory, "split.txt"), "working-tree version\n")
    const untrackedPath = "-- untracked ;$ note.txt"
    await writeFile(join(directory, untrackedPath), "new working-tree file\n")

    const status = parsePorcelainV2(git("status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"))
    const renamed = status.entries.find(entry => entry.kind === "renamed")
    assert.ok(renamed)
    assert.equal(renamed.path, "new name\\x0Afile.txt")
    assert.equal(renamed.originalPath, "old name\\x0Afile.txt")

    const numstat = parseNumstatZ(git("diff", "--cached", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"))
    const renameStats = numstat.entries.find(entry => entry.originalPath)
    assert.ok(renameStats)
    assert.deepEqual([renameStats.path, renameStats.originalPath, renameStats.additions, renameStats.deletions, renameStats.binary],
      ["new name\\x0Afile.txt", "old name\\x0Afile.txt", 1, 0, false])
    assert.equal(numstat.entries.find(entry => entry.path === "binary fixture.bin")?.binary, true)
    assert.equal(status.truncated || numstat.truncated, false)

    const headBefore = git("rev-parse", "HEAD")
    const indexBefore = await readFile(join(directory, ".git", "index"))
    const snapshot = await inspectGit({ operation: "status", cwd: directory })
    assert.equal(snapshot.state, "ready")
    assert.equal(snapshot.truncated, false)
    const helperRename = snapshot.entries.find(entry => entry.kind === "renamed")
    assert.ok(helperRename)
    const diff = await inspectGit({
      operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint,
      entry: helperRename, view: "combined",
    })
    assert.equal(diff.state, "ready")
    assert.match(diff.patch, /three/)
    const split = snapshot.entries.find(entry => entry.path === "split.txt")
    assert.deepEqual([split.indexStatus, split.worktreeStatus], ["M", "M"])
    const stagedDiff = await inspectGit({ operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry: split, view: "staged" })
    const unstagedDiff = await inspectGit({ operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry: split, view: "unstaged" })
    assert.match(stagedDiff.patch, /staged version/)
    assert.doesNotMatch(stagedDiff.patch, /working-tree version/)
    assert.match(unstagedDiff.patch, /working-tree version/)
    const untracked = snapshot.entries.find(entry => entry.kind === "untracked")
    assert.equal(untracked.path, untrackedPath)
    const untrackedDiff = await inspectGit({ operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry: untracked, view: "combined" })
    assert.equal(untrackedDiff.state, "ready")
    assert.match(untrackedDiff.patch, /new working-tree file/)
    const binary = snapshot.entries.find(entry => entry.path === "binary fixture.bin")
    assert.equal(binary.binary, true)
    const binaryDiff = await inspectGit({ operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry: binary, view: "combined" })
    assert.equal(binaryDiff.state, "binary")
    assert.deepEqual(git("rev-parse", "HEAD"), headBefore, "status and diff inspection must not move HEAD")
    assert.deepEqual(await readFile(join(directory, ".git", "index")), indexBefore, "status and diff inspection must not rewrite the index")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("external clean/smudge/process filters are shadowed and their files stay metadata-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "still-git-filter-"))
  const templates = join(directory, "empty-template"), hooks = join(directory, "empty-hooks"), marker = join(directory, "filter-ran")
  await mkdir(templates); await mkdir(hooks)
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  const git = (...args) => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], { cwd: directory, env, encoding: null })
    assert.equal(result.status, 0, result.stderr?.toString("utf8"))
    return result.stdout
  }
  try {
    git("init", "-q", `--template=${templates}`)
    git("config", "user.name", "Still filter fixture")
    git("config", "user.email", "still-filter@example.invalid")
    git("config", "commit.gpgsign", "false")
    await writeFile(join(directory, ".gitattributes"), "filtered.txt filter=sentinel\n")
    await writeFile(join(directory, "filtered.txt"), "filtered working-tree content\n")
    await writeFile(join(directory, "ordinary.txt"), "ordinary base\n")
    git("add", "--", ".gitattributes", "filtered.txt", "ordinary.txt")
    git("commit", "-qm", "filter fixture")
    const command = `touch ${marker}`
    git("config", "filter.sentinel.clean", command)
    git("config", "filter.sentinel.smudge", command)
    git("config", "filter.sentinel.process", command)
    git("config", "filter.sentinel.required", "true")
    git("config", "core.fsmonitor", command)
    git("config", "diff.external", command)
    await writeFile(join(directory, "filtered.txt"), "updated filtered working-tree content\n")
    await writeFile(join(directory, "ordinary.txt"), "ordinary updated\n")

    const snapshot = await inspectGit({ operation: "status", cwd: directory })
    assert.equal(snapshot.state, "ready")
    const file = snapshot.entries.find(entry => entry.path === "filtered.txt")
    assert.ok(file)
    assert.equal(file.contentState, "unsupportedPath")
    assert.equal(file.additions, null)
    assert.equal(file.deletions, null)
    const diff = await inspectGit({ operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry: file, view: "combined" })
    assert.equal(diff.state, "unsupportedPath")
    const ordinary = snapshot.entries.find(entry => entry.path === "ordinary.txt")
    const ordinaryDiff = await inspectGit({ operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry: ordinary, view: "combined" })
    assert.equal(ordinaryDiff.state, "ready")
    assert.match(ordinaryDiff.patch, /ordinary updated/)
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "filter commands in repository config must never be executed")
    assert.equal(git("config", "--get", "filter.sentinel.required").toString("utf8").trim(), "true", "the helper must not change repository configuration")
    for (const key of ["filter.sentinel.clean", "filter.sentinel.smudge", "filter.sentinel.process", "filter.sentinel.required"]) git("config", "--unset-all", key)
    const noFilterSnapshot = await inspectGit({ operation: "status", cwd: directory })
    assert.notEqual(noFilterSnapshot.fingerprint, snapshot.fingerprint, "filter-policy changes must invalidate the private snapshot fingerprint")
    const stale = await inspectGit({ operation: "diff", cwd: directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry: file, view: "combined" })
    assert.equal(stale.state, "stale", "filter-policy changes invalidate a cached per-file preview decision")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("unborn repositories expose independent staged, unstaged and combined read-only views", async () => {
  const fixture = await gitFixture("unborn")
  try {
    const path = "-- staged file.txt"
    await writeFile(join(fixture.directory, path), "staged version\n")
    fixture.git("add", "--", path)
    await writeFile(join(fixture.directory, path), "working version\n")
    const snapshot = await inspectGit({ operation: "status", cwd: fixture.directory })
    assert.equal(snapshot.state, "ready")
    assert.equal(snapshot.unborn, true)
    assert.equal(snapshot.headOid, null)
    const entry = snapshot.entries.find(item => item.path === path)
    assert.ok(entry)
    const request = view => inspectGit({ operation: "diff", cwd: fixture.directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry, view })
    const [staged, unstaged, combined] = await Promise.all([request("staged"), request("unstaged"), request("combined")])
    assert.deepEqual([staged.state, unstaged.state, combined.state], ["ready", "ready", "ready"])
    assert.match(staged.patch, /staged version/)
    assert.doesNotMatch(staged.patch, /working version/)
    assert.match(unstaged.patch, /working version/)
    assert.match(combined.patch, /working version/)
  } finally { await fixture.cleanup() }
})

test("untracked symlinks are reported as link metadata and never preview their targets", { skip: process.platform === "win32" }, async () => {
  const fixture = await gitFixture("symlink")
  try {
    const external = join(fixture.temporary, "outside-secret.txt")
    await writeFile(external, "DO NOT READ THIS EXTERNAL CONTENT\n")
    await symlink("../outside-secret.txt", join(fixture.directory, "external-link"))
    const snapshot = await inspectGit({ operation: "status", cwd: fixture.directory })
    const entry = snapshot.entries.find(item => item.path === "external-link")
    assert.equal(entry.pathType, "symlink")
    assert.equal(entry.pathLinkTarget, "../outside-secret.txt")
    const diff = await inspectGit({ operation: "diff", cwd: fixture.directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry, view: "combined" })
    assert.equal(diff.state, "symlink")
    assert.match(diff.reason, /outside-secret/)
    assert.equal(diff.patch, undefined)
  } finally { await fixture.cleanup() }
})

test("conflicts stay summaries and a same-status edit invalidates the saved file signature", async () => {
  const fixture = await gitFixture("race")
  try {
    await writeFile(join(fixture.directory, "conflict.txt"), "base\n")
    fixture.git("add", "--", "conflict.txt"); fixture.git("commit", "-qm", "base")
    const baseBranch = fixture.git("symbolic-ref", "--short", "HEAD").toString("utf8").trim()
    fixture.git("checkout", "-qb", "side")
    await writeFile(join(fixture.directory, "conflict.txt"), "side change\n")
    fixture.git("add", "--", "conflict.txt"); fixture.git("commit", "-qm", "side")
    fixture.git("checkout", "-q", baseBranch)
    await writeFile(join(fixture.directory, "conflict.txt"), "main change\n")
    fixture.git("add", "--", "conflict.txt"); fixture.git("commit", "-qm", "main")
    const merge = fixture.run("merge", "side")
    assert.notEqual(merge.status, 0, "fixture merge must leave a real conflict")
    const conflictSnapshot = await inspectGit({ operation: "status", cwd: fixture.directory })
    const conflict = conflictSnapshot.entries.find(entry => entry.path === "conflict.txt")
    assert.equal(conflict.kind, "conflicted")
    const conflictDiff = await inspectGit({ operation: "diff", cwd: fixture.directory, root: conflictSnapshot.root, fingerprint: conflictSnapshot.fingerprint, entry: conflict, view: "combined" })
    assert.equal(conflictDiff.state, "conflict")
    assert.equal(conflictDiff.patch, undefined)

    await fixture.cleanup()
    const staleFixture = await gitFixture("stale")
    try {
      await writeFile(join(staleFixture.directory, "tracked.txt"), "base\n")
      staleFixture.git("add", "--", "tracked.txt"); staleFixture.git("commit", "-qm", "base")
      await writeFile(join(staleFixture.directory, "tracked.txt"), "changed\n")
      const snapshot = await inspectGit({ operation: "status", cwd: staleFixture.directory })
      const entry = snapshot.entries.find(item => item.path === "tracked.txt")
      await writeFile(join(staleFixture.directory, "tracked.txt"), "changed again with a different size\n")
      const stale = await inspectGit({ operation: "diff", cwd: staleFixture.directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry, view: "combined" })
      assert.equal(stale.state, "stale", "same XY state is not enough when the selected file signature changed")
    } finally { await staleFixture.cleanup() }
  } finally { await fixture.cleanup() }
})

test("diff previews never return partial output above the byte or line limits", async () => {
  const fixture = await gitFixture("diff-limits")
  try {
    await writeFile(join(fixture.directory, "many-lines.txt"), "base\n")
    await writeFile(join(fixture.directory, "many-bytes.txt"), "base\n")
    fixture.git("add", "--", "many-lines.txt", "many-bytes.txt"); fixture.git("commit", "-qm", "base")
    await writeFile(join(fixture.directory, "many-lines.txt"), "line\n".repeat(10_001))
    await writeFile(join(fixture.directory, "many-bytes.txt"), `${"x".repeat(600 * 1024)}\n`)
    const snapshot = await inspectGit({ operation: "status", cwd: fixture.directory })
    for (const path of ["many-lines.txt", "many-bytes.txt"]) {
      const entry = snapshot.entries.find(item => item.path === path)
      const diff = await inspectGit({ operation: "diff", cwd: fixture.directory, root: snapshot.root, fingerprint: snapshot.fingerprint, entry, view: "combined" })
      assert.equal(diff.state, "tooLarge", `${path} must not be returned as a cut patch`)
      assert.equal(diff.patch, undefined)
    }
  } finally { await fixture.cleanup() }
})

test("nonrepository folders and bare repositories are not reported as clean worktrees", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "still-git-not-repo-"))
  try {
    const plain = join(temporary, "plain"), bare = join(temporary, "bare.git")
    await mkdir(plain)
    const init = spawnSync("git", ["init", "--bare", "-q", bare], { encoding: "utf8" })
    assert.equal(init.status, 0, init.stderr)
    const nonRepository = await inspectGit({ operation: "status", cwd: plain })
    const bareRepository = await inspectGit({ operation: "status", cwd: bare })
    assert.equal(nonRepository.state, "notRepository")
    assert.equal(bareRepository.state, "notRepository")
    assert.match(bareRepository.reason, /Bare repositories/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test("inherited Git repository selectors and command-config environment cannot redirect inspection", async () => {
  const fixture = await gitFixture("env")
  const marker = join(fixture.temporary, "inherited-config-ran")
  const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
  const saved = new Map(keys.map(key => [key, process.env[key]]))
  try {
    await writeFile(join(fixture.directory, "tracked.txt"), "base\n")
    fixture.git("add", "--", "tracked.txt"); fixture.git("commit", "-qm", "base")
    await writeFile(join(fixture.directory, "tracked.txt"), "changed\n")
    process.env.GIT_DIR = join(fixture.temporary, "not-a-git-dir")
    process.env.GIT_WORK_TREE = join(fixture.temporary, "wrong-worktree")
    process.env.GIT_INDEX_FILE = join(fixture.temporary, "wrong-index")
    process.env.GIT_OBJECT_DIRECTORY = join(fixture.temporary, "wrong-objects")
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(fixture.temporary, "wrong-alternates")
    process.env.GIT_CONFIG_COUNT = "1"
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor"
    process.env.GIT_CONFIG_VALUE_0 = `touch ${marker}`
    const snapshot = await inspectGit({ operation: "status", cwd: fixture.directory })
    assert.equal(snapshot.state, "ready")
    assert.equal(snapshot.root, await realpath(fixture.directory))
    assert.ok(snapshot.entries.some(entry => entry.path === "tracked.txt"))
    await assert.rejects(readFile(marker), { code: "ENOENT" })
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fixture.cleanup()
  }
})

test("a selected subfolder resolves to and reports the containing worktree root", async () => {
  const fixture = await gitFixture("subfolder")
  try {
    await writeFile(join(fixture.directory, "root-level.txt"), "base\n")
    await mkdir(join(fixture.directory, "project"))
    fixture.git("add", "--", "root-level.txt"); fixture.git("commit", "-qm", "base")
    await writeFile(join(fixture.directory, "root-level.txt"), "changed outside the selected subfolder\n")
    const snapshot = await inspectGit({ operation: "status", cwd: join(fixture.directory, "project") })
    assert.equal(snapshot.root, await realpath(fixture.directory))
    assert.ok(snapshot.entries.some(entry => entry.path === "root-level.txt"))
  } finally { await fixture.cleanup() }
})

test("the native fixed loader imports the bundled helper from stdin and frames typed errors", async () => {
  const nativeSource = await readFile(new URL("../src-tauri/src/agent_git.rs", import.meta.url), "utf8")
  const loader = nativeSource.match(/const GIT_LOADER: &str = r#"([\s\S]*?)"#;/)?.[1]
  const source = await readFile(new URL("../src-tauri/agent-host/git-review.mjs", import.meta.url), "utf8")
  assert.ok(loader)
  const prefix = "STILL_GIT_RESULT_loader_fixture:"
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", loader.replace("__PREFIX__", prefix)], {
    input: JSON.stringify({ source, request: { operation: "invalid", cwd: "/tmp" } }), encoding: "utf8",
  })
  assert.equal(child.status, 1, child.stderr)
  const output = child.stdout.trim()
  assert.ok(output.startsWith(prefix))
  const frame = JSON.parse(output.slice(prefix.length))
  assert.equal(frame.ok, false)
  assert.equal(frame.error.code, "invalidRequest")
})
