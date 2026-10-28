import hljs from "highlight.js/lib/core"
import javascript from "highlight.js/lib/languages/javascript"
import typescript from "highlight.js/lib/languages/typescript"
import json from "highlight.js/lib/languages/json"
import bash from "highlight.js/lib/languages/bash"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import css from "highlight.js/lib/languages/css"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import sql from "highlight.js/lib/languages/sql"

for (const [name, grammar] of Object.entries({ javascript, typescript, json, bash, python, rust, css, xml, yaml, sql })) hljs.registerLanguage(name, grammar)
const aliases: Record<string, string> = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", sh: "bash", shell: "bash", zsh: "bash", py: "python", rs: "rust", html: "xml", svg: "xml", yml: "yaml" }

/** Only highlight.js output enters innerHTML; unknown or very large inputs remain React text. */
export function highlightCode(text: string, language?: string): string | null {
  const name = language ? aliases[language.toLowerCase()] || language.toLowerCase() : ""
  if (!name || !hljs.getLanguage(name) || text.length > 80000) return null
  try { return hljs.highlight(text, { language: name, ignoreIllegals: true }).value } catch { return null }
}
export function languageForPath(path: string): string | undefined { return path.split(".").pop()?.toLowerCase() }
