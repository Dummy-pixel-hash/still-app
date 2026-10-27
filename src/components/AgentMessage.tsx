import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { AgentToolContent } from "../agents/types"
import { openExternalUrl } from "../bridge/external"
import { Children, isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import AgentIcon from "./AgentIcon"

function CodeBlock({ children }: { children?: ReactNode }) {
  const content = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false), [error, setError] = useState("")
  const child = Children.toArray(children).find(isValidElement)
  const language = child && isValidElement<{ className?: string }>(child) ? child.props.className?.match(/language-([^\s]+)/)?.[1] : undefined
  const text = child && isValidElement<{ children?: ReactNode }>(child) ? child.props.children : undefined
  useEffect(() => { setCopied(false) }, [text])
  return <div className="agent-code"><div className="agent-code-header"><span>{language || "Code"}</span><button type="button" onClick={() => { void nativeBridge.clipboardWriteText(content.current?.textContent || "").then(() => { setCopied(true); setError("") }).catch(() => setError("Could not copy. Select the code and copy it manually.")) }} aria-label="Copy code"><AgentIcon name={copied ? "check" : "file"} size={13} />{copied ? "Copied" : "Copy"}</button></div><pre ref={content}>{children}</pre>{error && <p className="agent-copy-error" role="status">{error}</p>}</div>
}

/** Standard markdown/GFM, with raw HTML disabled and safe URL transformation. */
const markdownComponents: Components = {
      a: ({ href, children }) => <a
        href={href}
        title="Ctrl/Cmd+click to open in your browser"
        onClick={(event) => {
          event.preventDefault()
          if (event.ctrlKey || event.metaKey) void openExternalUrl(href).catch(() => {})
        }}
        onAuxClick={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return
          event.preventDefault()
          void openExternalUrl(href).catch(() => {})
        }}
      >{children}</a>,
      pre: CodeBlock,
       table: ({ children }) => <div className="agent-table"><table>{children}</table></div>,
       img: ({ src, alt }) => <span className="agent-media-fallback">{alt || "Image"}{src && <a href={src} onClick={event => { event.preventDefault(); void openExternalUrl(src).catch(() => {}) }}>Open image in browser</a>}</span>,
}
export const AgentMessage = memo(function AgentMessage({ text }: { text: string }) {
  return <div className="agent-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{text}</ReactMarkdown></div>
})

export function AgentToolResult({ content }: { content: AgentToolContent[] }) {
  return <>{content.map((entry, index) => entry.type === "diff"
    ? <div className="agent-diff" key={index}><div className="agent-code-language">{entry.path}</div>
      <details><summary>Before</summary><pre>{entry.oldText ?? "New file"}</pre></details>
      <details open><summary>After</summary><pre>{entry.newText}</pre></details></div>
    : entry.type === "patch" ? <Patch key={index} path={entry.path} patch={entry.patch} />
      : entry.content?.type === "text" && entry.content.text ? <pre key={index}>{entry.content.text}</pre> : <p key={index} className="agent-muted">The agent supplied {entry.content?.type || "unsupported"} content. A text preview is unavailable.</p>)}</>
}

function Patch({ path, patch }: { path: string; patch: string }) {
  let before = 0, after = 0
  const lines = patch.split("\n").map(line => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) { before = Number(hunk[1]); after = Number(hunk[2]); return { line, style: "diff-hunk", before: "", after: "" } }
    if (/^(---|\+\+\+|diff |index |\\)/.test(line)) return { line, style: "diff-meta", before: "", after: "" }
    return { line, style: line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "", before: line.startsWith("+") ? "" : String(before++ || ""), after: line.startsWith("-") ? "" : String(after++ || "") }
  })
  return <div className="agent-diff"><div className="agent-code-language">{path}</div><pre className="agent-patch">{lines.map((row, index) => <span className={`agent-diff-line ${row.style}`} key={index}><span className="agent-line-number" aria-hidden="true">{row.before}</span><span className="agent-line-number" aria-hidden="true">{row.after}</span><code>{row.line}{"\n"}</code></span>)}</pre></div>
}
