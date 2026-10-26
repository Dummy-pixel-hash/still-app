import { Fragment, type ReactNode } from "react"
import type { AgentToolContent } from "../agents/types"

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g).map((part, i) => {
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/)
    if (link && /^https?:\/\//i.test(link[2])) return <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
    return <Fragment key={i}>{part}</Fragment>
  })
}

/** Small, safe renderer for common agent prose. Never inject HTML from the server. */
export function AgentMessage({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    const fence = line.match(/^\s*```([\w+-]*)/)
    if (fence) {
      const code: string[] = []; i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      i++
      blocks.push(<div className="agent-code" key={i}>{fence[1] && <div className="agent-code-language">{fence[1]}</div>}<pre><code>{code.join("\n")}</code></pre></div>)
    } else if (!line.trim()) i++
    else if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h3 key={i}>{inline(line.replace(/^#{1,6}\s+/, ""))}</h3>); i++
    } else if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const list: ReactNode[] = []
      while (i < lines.length && (ordered ? /^\s*\d+\.\s/ : /^\s*[-*]\s/).test(lines[i])) {
        list.push(<li key={i}>{inline(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>); i++
      }
      blocks.push(ordered ? <ol key={i}>{list}</ol> : <ul key={i}>{list}</ul>)
    } else {
      const paragraph: string[] = [line]; i++
      while (i < lines.length && lines[i].trim() && !/^\s*(?:```|#{1,6}\s|[-*]\s|\d+\.\s)/.test(lines[i])) paragraph.push(lines[i++])
      blocks.push(<p key={i}>{inline(paragraph.join("\n"))}</p>)
    }
  }
  return <div className="agent-prose">{blocks}</div>
}

export function AgentToolResult({ content }: { content: AgentToolContent[] }) {
  return <>{content.map((entry, i) => entry.type === "diff"
    ? <div className="agent-diff" key={i}><div className="agent-code-language">{entry.path}</div>
      <details><summary>Before</summary><pre>{entry.oldText ?? "New file"}</pre></details>
      <details open><summary>After</summary><pre>{entry.newText}</pre></details></div>
    : entry.content?.type === "text" && entry.content.text
      ? <pre key={i}>{entry.content.text}</pre> : null)}</>
}
