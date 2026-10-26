import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { AgentToolContent } from "../agents/types"

/** Standard markdown/GFM, with raw HTML disabled and safe URL transformation. */
export function AgentMessage({ text }: { text: string }) {
  return <div className="agent-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
    components={{
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      pre: ({ children }) => <div className="agent-code"><pre>{children}</pre></div>,
      table: ({ children }) => <div className="agent-table"><table>{children}</table></div>,
    }}>{text}</ReactMarkdown></div>
}

export function AgentToolResult({ content }: { content: AgentToolContent[] }) {
  return <>{content.map((entry, index) => entry.type === "diff"
    ? <div className="agent-diff" key={index}><div className="agent-code-language">{entry.path}</div>
      <details><summary>Before</summary><pre>{entry.oldText ?? "New file"}</pre></details>
      <details open><summary>After</summary><pre>{entry.newText}</pre></details></div>
    : entry.type === "patch" ? <div className="agent-diff" key={index}><div className="agent-code-language">{entry.path}</div><pre>{entry.patch.split("\n").map((line, i) => <span className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""} key={i}>{line}{"\n"}</span>)}</pre></div>
      : entry.content?.type === "text" && entry.content.text ? <pre key={index}>{entry.content.text}</pre> : null)}</>
}
