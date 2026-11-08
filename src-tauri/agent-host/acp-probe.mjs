// Explicit, bounded ACP initialize probe. Never creates a session or sends a prompt.
import { spawn } from "node:child_process"

export function testConnection(executable, args, timeout = 8000) {
  return new Promise(resolve => {
    let child, pending = "", bytes = 0, finished = false
    let timer
    const finish = result => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted)
      child.stdin?.destroy()
      const kill = signal => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch { /* Already exited. */ }
      }
      kill("SIGTERM")
      // Also terminate descendants that outlive the ACP parent.
      setTimeout(() => { kill("SIGKILL"); resolve(result) }, 150)
    }
    const interrupted = () => finish({ error: "ACP connection test was interrupted." })
    process.once("SIGTERM", interrupted); process.once("SIGINT", interrupted)
    child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" })
    timer = setTimeout(() => finish({ error: "ACP negotiation timed out. Check the arguments, installation, and server-side sign-in." }), timeout)
    child.on("error", error => finish({ error: error.code === "ENOENT" ? "Executable not found on this server." : "Could not start the ACP executable. Check its path and permissions." }))
    child.stdin.on("error", () => finish({ error: "The agent closed its ACP input before negotiation completed." }))
    child.on("exit", () => finish({ error: "The agent exited before completing ACP negotiation. Check its arguments and server-side sign-in." }))
    child.stderr.on("data", data => { bytes += data.length; if (bytes > 65536) finish({ error: "The agent produced too much output during ACP negotiation." }) })
    child.stdout.setEncoding("utf8").on("data", data => {
      if (finished) return
      bytes += Buffer.byteLength(data)
      if (bytes > 65536) { finish({ error: "The agent produced too much output during ACP negotiation." }); return }
      pending += data
      let end
      while ((end = pending.indexOf("\n")) >= 0 && !finished) {
        const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { finish({ error: "The executable did not speak ACP over stdio. Check the protocol arguments." }); return }
        if (!message || typeof message !== "object" || Array.isArray(message)) { finish({ error: "The executable did not speak ACP over stdio. Check the protocol arguments." }); return }
        if (message.id !== "still-probe") continue
        if (message.error) { finish({ error: "The agent rejected ACP initialization. Check its protocol version and server-side sign-in." }); return }
        if (message.result?.protocolVersion !== 1 || !message.result?.agentCapabilities || typeof message.result.agentCapabilities !== "object" || Array.isArray(message.result.agentCapabilities)) {
          finish({ error: "The executable returned an incompatible ACP initialization response." }); return
        }
        finish({ ready: true })
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "still-probe", method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "still-connection-test", version: "1" }, clientCapabilities: {} } }) + "\n")
  })
}

if (process.argv[1] === "--still-acp-probe") {
  const config = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"))
  const result = await testConnection(config.executable, config.args)
  console.log("STILL_ACP_PROBE:" + JSON.stringify(result))
}
