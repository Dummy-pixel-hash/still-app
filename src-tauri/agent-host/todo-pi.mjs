import { createHash } from "node:crypto"
import { todoTool, chatTitleTool, subagentTool, hostTools, todoConnection, requestTodos, requestChatTitle, requestSubagents, markTodoToolReady } from "./todos.mjs"

// Provider call IDs can contain characters outside the operation-identity alphabet (e.g. `call|item`).
export const operationId = callId => `pi:${createHash("sha256").update(String(callId)).digest("hex")}`

export default function stillTodos(pi) {
  const connection = todoConnection()
  pi.registerTool({
    name: todoTool.name,
    label: "Still todos",
    description: todoTool.description,
    parameters: todoTool.inputSchema,
    async execute(callId, input, signal) {
      const list = await requestTodos(connection, input, `pi:${callId}`, signal)
      return { content: [{ type: "text", text: JSON.stringify(list) }], details: list }
    },
  })
  if (hostTools().includes(subagentTool)) pi.registerTool({
    name: subagentTool.name,
    label: "Manage subagents",
    description: subagentTool.description,
    parameters: subagentTool.inputSchema,
    async execute(callId, input, signal) {
      const state = await requestSubagents(connection, input, operationId(callId), signal)
      return { content: [{ type: "text", text: JSON.stringify(state) }], details: state }
    },
  })
  pi.registerTool({
    name: chatTitleTool.name,
    label: "Set conversation title",
    description: chatTitleTool.description,
    parameters: chatTitleTool.inputSchema,
    async execute(callId, input, signal) {
      const title = await requestChatTitle(connection, input, `pi:${callId}`, signal)
      return { content: [{ type: "text", text: JSON.stringify(title) }], details: title }
    },
  })
  pi.on("session_start", async () => { await markTodoToolReady(connection) })
}
