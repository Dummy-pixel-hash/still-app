import { todoTool, chatTitleTool, todoConnection, requestTodos, requestChatTitle, markTodoToolReady } from "./todos.mjs"

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
