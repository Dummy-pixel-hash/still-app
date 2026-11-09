import { mockBridge } from "../bridge/mockBridge"
import { registerNativeBridge, type ConnectArgs, type NativeBridge, type NativeSessionEvent } from "../bridge/nativeBridge"
import { DEFAULT_ORB_PREFERENCES } from "../orb/state"
import { connectSession, disconnectSession } from "../session/connections"
import type { AppSettings, Project, Session } from "../types"
import { isTerminalPreview, TERMINAL_PREVIEW_STORE_KEY } from "./mode"

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
const green = (text: string) => `\x1b[32m${text}\x1b[0m`
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`
const lines = (...rows: string[]) => rows.join("\r\n")

interface SampleTerminal {
  id: string
  name: string
  projectId: string
  host: string
  directory: string
  output: string
  saved?: boolean
}

const projects: Project[] = [
  { id: "preview-still", name: "Still", note: "App development · browser preview", order: 0 },
  { id: "preview-infra", name: "Infrastructure", note: "Services and deployments · simulated hosts", order: 1 },
  { id: "preview-lab", name: "Lab", note: "Small experiments and weekend builds", order: 2 },
]

const samples: SampleTerminal[] = [
  {
    id: "web", name: "Web · dev server", projectId: "preview-still", host: "dev.preview.invalid", directory: "~/work/still",
    output: lines(
      "$ npm run dev", "", `  ${green("VITE v7.3.0")}  ready in ${green("184 ms")}`, "",
      `  ${green("➜")}  Local:   ${cyan("http://localhost:1420/")}`,
      `  ${green("➜")}  Network: ${cyan("http://dev.preview.invalid:1420/")}`, "",
      `${dim("10:42:18")} ${cyan("[vite]")} hmr update /src/screens/Workspace.tsx`,
      `${dim("10:42:26")} ${cyan("[vite]")} hmr update /src/styles/theme.css`,
      `${dim("10:43:02")} ${cyan("[vite]")} page reload src/main.tsx`,
      "", dim("Watching for file changes…"),
    ),
  },
  {
    id: "api", name: "API · request logs", projectId: "preview-still", host: "dev.preview.invalid", directory: "~/work/still-api",
    output: lines(
      "$ npm run dev:api", "", `${green("●")} API listening on :3001`, dim("Environment: development"), "",
      `${dim("10:42:12")} ${green("200")} GET  /health                 2ms`,
      `${dim("10:42:18")} ${green("200")} GET  /api/projects           8ms`,
      `${dim("10:42:18")} ${green("200")} GET  /api/sessions          12ms`,
      `${dim("10:42:21")} ${green("201")} POST /api/sessions          18ms`,
      `${dim("10:42:26")} ${green("200")} GET  /api/projects/still     4ms`,
      `${dim("10:43:02")} ${cyan("WS ")} session attached`, "", dim("Waiting for requests…"),
    ),
  },
  {
    id: "tests", name: "Tests · workspace", projectId: "preview-still", host: "dev.preview.invalid", directory: "~/work/still",
    output: lines(
      "$ npm test", "", cyan(" RUN  v3.2.0  ~/work/still"), "",
      `${green(" ✓")} session-store.test.ts     (12 tests)  24ms`,
      `${green(" ✓")} terminal-preview.test.ts   (8 tests)  18ms`,
      `${green(" ✓")} project-order.test.ts      (6 tests)  11ms`,
      `${green(" ✓")} workspace.test.ts          (9 tests)  32ms`, "",
      ` Test Files  ${green("4 passed")} (4)`, `      Tests  ${green("35 passed")} (35)`,
      "   Duration  1.42s", "", dim("PASS  Watching for file changes…"),
    ),
  },
  {
    id: "git", name: "Shell · feature branch", projectId: "preview-still", host: "dev.preview.invalid", directory: "~/work/still",
    output: lines(
      "$ git status --short --branch", cyan("## feat/terminal-preview...origin/main"),
      ` ${yellow("M")} src/screens/Workspace.tsx`, ` ${yellow("M")} src/components/SessionCard.tsx`,
      `${green("??")} src/preview/terminals.ts`, "", "$ git log --oneline -3",
      `${yellow("a4f81c2")} Keep terminal previews crisp at every size`,
      `${yellow("e7c309a")} Restore the last active workspace`,
      `${yellow("86ba1d4")} Simplify project navigation`, "",
    ),
  },
  {
    id: "services", name: "Services · staging", projectId: "preview-infra", host: "staging.preview.invalid", directory: "/srv/still",
    output: lines(
      "$ docker compose ps", "", "NAME          SERVICE    STATUS              PORTS",
      `still-web     web        ${green("Up 3 hours")}          :8080`,
      `still-api     api        ${green("Up 3 hours (healthy)")} :3001`,
      `still-db      postgres   ${green("Up 3 days (healthy)")}  :5432`,
      `still-cache   redis      ${green("Up 3 days")}           :6379`, "",
      "$ docker compose logs --tail=3 api",
      `${dim("api |")} ${green("INFO")} Health check passed`,
      `${dim("api |")} ${green("INFO")} Connected to database`,
      `${dim("api |")} ${green("INFO")} Ready to accept requests`, "",
    ),
  },
  {
    id: "deploy", name: "Deploy · release check", projectId: "preview-infra", host: "staging.preview.invalid", directory: "/srv/still",
    output: lines(
      "$ ./scripts/check-release.sh v0.1.1", "",
      `${green(" ✓")} Build artifacts verified`, `${green(" ✓")} Database migrations up to date`,
      `${green(" ✓")} Staging health checks passed`, `${green(" ✓")} Rollback snapshot available`, "",
      yellow(" Release is ready for review. No deployment started."), "",
    ),
    saved: true,
  },
  {
    id: "experiment", name: "Shell · particle study", projectId: "preview-lab", host: "lab.preview.invalid", directory: "~/experiments/aurora",
    output: lines(
      "$ cargo test", "", `${green("   Compiling")} aurora v0.1.0`,
      `${green("    Finished")} test profile in 0.84s`, "", "running 3 tests",
      `test particles::stays_within_bounds ... ${green("ok")}`,
      `test palette::preserves_luminance ... ${green("ok")}`,
      `test blur::keeps_opaque_alpha ... ${green("ok")}`, "",
      green("test result: ok. 3 passed; 0 failed"), "",
    ),
  },
  {
    id: "notes", name: "Notes · next steps", projectId: "preview-lab", host: "lab.preview.invalid", directory: "~/experiments",
    output: lines(
      "$ cat next-steps.md", "", cyan("# Next session"), "",
      "  [x] Try the shared particle texture", "  [x] Check the small-screen layout",
      "  [ ] Compare Windows and Linux renders", "  [ ] Record the terminal walkthrough", "",
    ),
    saved: true,
  },
]

function seedPreviewStore(): Session[] {
  try {
    const existing = JSON.parse(localStorage.getItem(TERMINAL_PREVIEW_STORE_KEY) || "null")
    if (existing && Array.isArray(existing.projects) && Array.isArray(existing.sessions)) return existing.sessions
  } catch {
    // Only the disposable preview store is reset if its metadata is unreadable.
  }
  const now = Date.now()
  const sessions: Session[] = samples.map((sample, index) => ({
    id: `preview-terminal-${sample.id}`, transport: "ssh", name: sample.name,
    projectId: sample.projectId, host: sample.host, port: 22, username: "dev",
    workingDirectory: sample.directory, authMethod: "ask", remember: false,
    tmuxSession: `preview-${sample.id}`, createdAt: now - 86400000,
    updatedAt: now - index * 300000, lastOpenedAt: now - (index + 1) * 300000,
  }))
  const settings: AppSettings = {
    confirmRemove: true, terminal: { fontSize: 14, cursorStyle: "block", scrollback: 5000 },
    imageInsertStyle: "path", orb: { ...DEFAULT_ORB_PREFERENCES },
  }
  localStorage.setItem(TERMINAL_PREVIEW_STORE_KEY, JSON.stringify({
    projects, sessions, keys: [], settings,
    order: Object.fromEntries(projects.map(project => [project.id, sessions.filter(session => session.projectId === project.id).map(session => session.id)])),
  }))
  return sessions
}

interface PreviewConnection {
  args: ConnectArgs
  sample?: SampleTerminal
  listeners: Set<(event: NativeSessionEvent) => void>
  input: string
  started: boolean
}

/** A local simulation, not a shell: no sockets, processes, or credentials. */
function createTerminalPreviewBridge(): NativeBridge {
  const connections = new Map<string, PreviewConnection>()
  const encoder = new TextEncoder()
  let generation = 0
  const output = (connection: PreviewConnection, text: string) => {
    const event: NativeSessionEvent = { type: "data", data: Array.from(encoder.encode(text)) }
    connection.listeners.forEach(listener => listener(event))
  }
  const prompt = (connection: PreviewConnection) => `${cyan("dev@preview")} ${dim(connection.args.workingDirectory || "~")} $ `
  const header = dim("Still terminal preview · simulated output · no network or commands")
  const snapshot = (connection: PreviewConnection) => `\x1b[2J\x1b[H${header}\r\n\r\n${connection.sample?.output || ""}\r\n${prompt(connection)}`
  const command = (connection: PreviewConnection, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return ""
    if (trimmed === "clear") return "\x1b[2J\x1b[H"
    if (trimmed === "help") return lines("Local UI simulation. Nothing is executed.", "Try: pwd, ls, git status, echo <text>, clear", "")
    if (trimmed === "pwd") return `${connection.args.workingDirectory || "~"}\r\n`
    if (trimmed === "ls") return `${cyan("src/")}  ${cyan("tests/")}  README.md  package.json\r\n`
    if (trimmed === "git status") return "On branch feat/terminal-preview\r\nNothing to commit (simulated).\r\n"
    if (trimmed.startsWith("echo ")) return `${trimmed.slice(5)}\r\n`
    return "Preview only — no command was executed. Type help for sample commands.\r\n"
  }
  return {
    ...mockBridge,
    adapterName: "Terminal preview · local simulation",
    async connect(args) {
      const sessionId = `terminal-preview-${++generation}`
      connections.set(sessionId, {
        args, sample: samples.find(sample => `preview-${sample.id}` === args.tmuxSession),
        listeners: new Set(), input: "", started: false,
      })
      return { sessionId, status: "connected" }
    },
    async subscribeToSession(id, callback) {
      const connection = connections.get(id)
      if (!connection) return () => {}
      connection.listeners.add(callback)
      queueMicrotask(() => {
        if (!connection.started && connections.get(id) === connection && connection.listeners.size) {
          connection.started = true
          output(connection, snapshot(connection))
        }
      })
      return () => { connection.listeners.delete(callback) }
    },
    async status(id) {
      return { status: connections.has(id) ? "connected" : "disconnected", lastError: null }
    },
    async disconnect(id) {
      const connection = connections.get(id)
      if (!connection) return
      connections.delete(id)
      connection.listeners.forEach(listener => listener({ type: "status", status: "disconnected" }))
      connection.listeners.clear()
    },
    async write(id, data) {
      const connection = connections.get(id)
      if (!connection) return
      const text = typeof data === "string" ? data : new TextDecoder().decode(data)
      let echoed = ""
      for (const character of text.replace(/\r\n/g, "\r")) {
        if (character === "\r" || character === "\n") {
          echoed += `\r\n${command(connection, connection.input)}${prompt(connection)}`
          connection.input = ""
        } else if (character === "\x7f" || character === "\b") {
          if (connection.input) { connection.input = Array.from(connection.input).slice(0, -1).join(""); echoed += "\b \b" }
        } else if (character === "\x03") {
          connection.input = ""; echoed += `^C\r\n${prompt(connection)}`
        } else if (character >= " " && connection.input.length < 4096) {
          connection.input += character; echoed += character
        }
      }
      if (echoed) output(connection, echoed)
    },
    async hasCredential() { return true }, // No authentication happens in this adapter.
    async resize() {},
    async refresh() {},
  }
}

export async function startTerminalPreview(): Promise<void> {
  if (!isTerminalPreview()) return
  const sessions = seedPreviewStore()
  registerNativeBridge(createTerminalPreviewBridge())
  await Promise.all(sessions.map(async session => {
    await connectSession({
      localId: session.id, host: session.host, port: session.port, username: session.username,
      workingDirectory: session.workingDirectory, tmuxSession: session.tmuxSession,
      authKind: "password", cols: 100, rows: 24,
    })
    // Detached samples retain their screen, just like a real saved session.
    if (samples.find(sample => `preview-${sample.id}` === session.tmuxSession)?.saved) {
      await disconnectSession(session.id)
    }
  }))
}
