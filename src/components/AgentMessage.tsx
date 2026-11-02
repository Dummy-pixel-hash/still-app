import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { AgentToolContent } from "../agents/types"
import { openExternalUrl } from "../bridge/external"
import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { nativeBridge } from "../bridge/nativeBridge"
import AgentIcon from "./AgentIcon"
import { describeChanges, type ReportedChange } from "../agents/changes"
import type { StructuredPatchHunk } from "diff"
import { highlightCode, languageForPath } from "../agents/syntax"

function CodeBlock({ children }: { children?: ReactNode }) {
  const content = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false), [error, setError] = useState("")
  const child = Children.toArray(children).find(isValidElement)
  const language = child && isValidElement<{ className?: string }>(child) ? child.props.className?.match(/language-([^\s]+)/)?.[1] : undefined
  const text = child && isValidElement<{ children?: ReactNode }>(child) ? child.props.children : undefined
  const highlighted = useMemo(() => typeof text === "string" ? highlightCode(text, language) : null, [text, language])
  useEffect(() => { setCopied(false) }, [text])
  return <div className="agent-code"><div className="agent-code-header"><span>{language || "Code"}</span><button type="button" onClick={() => { void nativeBridge.clipboardWriteText(content.current?.textContent || "").then(() => { setCopied(true); setError("") }).catch(() => setError("Could not copy. Select the code and copy it manually.")) }} aria-label="Copy code"><AgentIcon name={copied ? "check" : "file"} size={13} />{copied ? "Copied" : "Copy"}</button></div><pre ref={content}>{highlighted === null ? children : <code dangerouslySetInnerHTML={{ __html: highlighted }} />}</pre>{error && <p className="agent-copy-error" role="status">{error}</p>}</div>
}

function ExternalLink({ href, children, modifier = true }: { href?: string; children: ReactNode; modifier?: boolean }) {
  const [feedback, setFeedback] = useState<"" | "hint" | "failed" | "blocked">("")
  const open = async () => {
    setFeedback("")
    try { if (!await openExternalUrl(href)) setFeedback("blocked") }
    catch { setFeedback("failed") }
  }
  return <><a href={href} title={modifier ? "Ctrl/Cmd+click or press Enter to open in your browser" : "Open in your browser"} onClick={event => {
    event.preventDefault()
    if (!modifier || event.ctrlKey || event.metaKey) void open()
    else setFeedback("hint")
  }} onAuxClick={event => event.preventDefault()} onKeyDown={event => {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return
    event.preventDefault()
    void open()
  }}>{children}</a>{feedback && <span className="agent-link-feedback" role="status">{feedback === "blocked" ? "Only HTTP and HTTPS links can be opened." : <>{feedback === "failed" ? "Could not open your browser. " : "Opens in your browser. "}<button type="button" onClick={() => void open()}>{feedback === "failed" ? "Retry opening link" : "Open link"}</button></>}</span>}</>
}

/** Standard markdown/GFM, with raw HTML disabled and safe URL transformation. */
const markdownComponents: Components = {
       a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
      pre: CodeBlock,
       table: ({ children }) => <div className="agent-table"><table>{children}</table></div>,
       img: ({ src, alt }) => <span className="agent-media-fallback">{alt || "Image"}{src && <ExternalLink href={src} modifier={false}>Open image in browser</ExternalLink>}</span>,
}
export const AgentMessage = memo(function AgentMessage({ text }: { text: string }) {
  return <div className="agent-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{text}</ReactMarkdown></div>
})

export function AgentToolResult({ content }: { content: AgentToolContent[] }) {
  return <>{content.map((entry, index) => entry.type === "diff" || entry.type === "patch"
    ? describeChanges(entry).map((change, file) => <AgentChangeView key={`${index}:${file}`} change={change} />)
      : entry.content?.type === "text" && entry.content.text ? <pre key={index}>{entry.content.text}</pre> : <p key={index} className="agent-muted">The agent supplied {entry.content?.type || "unsupported"} content. A text preview is unavailable.</p>)}</>
}

export function AgentChangeView({ change, sourceLabel = "Original provider patch", header = true }: { change: ReportedChange; sourceLabel?: string; header?: boolean }) {
  if (change.preview === "written" && change.source.type === "diff") return <div className="agent-diff"><p className="agent-diff-fallback">Written content · the agent did not supply the original file. Line totals are unavailable.</p><pre className="agent-written-content" tabIndex={0} aria-label={`Written content for ${change.path}`}>{change.source.newText}</pre></div>
  return <div className="agent-diff">{header && <div className="agent-code-language"><AgentIcon name="file" size={13} /><span>{change.path}</span>{change.additions !== null && <span className="agent-change-numbers"><span>+{change.additions}</span><span>−{change.deletions}</span></span>}</div>}
    {change.preview === "snippet" && <p className="agent-diff-fallback">Reported replacement · line numbers are relative to the supplied snippet.</p>}
    {change.hunks !== null ? <>
      {change.hunks.length ? <Patch path={change.path} hunks={change.hunks} /> : <p className="agent-diff-fallback">No changed text lines were reported.</p>}
      {change.patch && <details className="agent-raw-patch"><summary>View raw patch</summary><pre>{change.patch}</pre></details>}
    </> : change.patch !== null ? <><p className="agent-diff-fallback">{sourceLabel} · line totals unavailable</p><pre>{change.patch}</pre></> : change.source.type === "diff" ? <><p className="agent-diff-fallback">Showing supplied before/after text for this large change.</p><details><summary>Before</summary><pre>{change.source.oldText ?? "New file"}</pre></details><details open><summary>After</summary><pre>{change.source.newText}</pre></details></> : null}
  </div>
}

const Patch = memo(function Patch({ path, hunks }: { path: string; hunks: StructuredPatchHunk[] }) {
  const lines = useMemo(() => {
    const colored = hunks.reduce((n, hunk) => n + hunk.lines.join("\n").length, 0) <= 80000
    return hunks.flatMap(hunk => {
      let before = hunk.oldStart, after = hunk.newStart
      return [{ text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, style: "diff-hunk", before: "", after: "", sign: "", html: null as string | null }, ...hunk.lines.map(line => {
        if (line.startsWith("\\")) return { text: line, style: "diff-meta", before: "", after: "", sign: "", html: null }
        const addition = line.startsWith("+"), removal = line.startsWith("-"), content = line.slice(1)
        return { text: content, style: addition ? "diff-add" : removal ? "diff-remove" : "", before: addition ? "" : String(before++), after: removal ? "" : String(after++), sign: addition ? "+" : removal ? "−" : " ", html: colored ? highlightCode(content, languageForPath(path)) : null }
      })]
    })
  }, [path, hunks])
  return <pre className="agent-patch" tabIndex={0} aria-label={`Code changes in ${path}`}>{lines.map((row, index) => <span className={`agent-diff-line ${row.style}`} key={index}><span className="agent-line-number" aria-hidden="true">{row.before}</span><span className="agent-line-number" aria-hidden="true">{row.after}</span><span className="agent-diff-sign" aria-hidden="true">{row.sign}</span>{row.html === null ? <code>{row.text}{"\n"}</code> : <code dangerouslySetInnerHTML={{ __html: row.html + "\n" }} />}</span>)}</pre>
})
