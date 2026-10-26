import type { CSSProperties } from "react"

export type AgentIconName = "back" | "chevron" | "plus" | "folder" | "chat" | "search" | "more" | "close" | "arrow" | "stop" | "settings" | "terminal" | "check" | "pin" | "archive" | "trash" | "edit" | "panel" | "refresh" | "code" | "file" | "command"
const paths: Record<AgentIconName, string> = {
  back: "m14 6-6 6 6 6M8 12h12", chevron: "m9 5 7 7-7 7", plus: "M12 5v14M5 12h14",
  folder: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z", chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0", more: "M5 12h.01M12 12h.01M19 12h.01",
  close: "m6 6 12 12M6 18 18 6", arrow: "M12 20V4m-6 6 6-6 6 6", stop: "M6 6h12v12H6Z",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6", terminal: "m4 6 6 6-6 6m9 0h7",
  check: "m5 12 4 4L19 6", pin: "m8 3 8 0-1 6 3 4v2H6v-2l3-4ZM12 15v7", archive: "M3 4h18v4H3ZM5 8v12h14V8M10 12h4",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7", edit: "m4 16 12-12 4 4L8 20H4ZM14 6l4 4",
  panel: "M3 4h18v16H3ZM9 4v16", refresh: "M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20", file: "M5 3h9l5 5v13H5ZM14 3v6h5M8 13h8M8 17h6", command: "M8 8h8v8H8ZM8 8H5a3 3 0 1 1 3-3v3Zm8 0V5a3 3 0 1 1 3 3h-3Zm0 8h3a3 3 0 1 1-3 3v-3Zm-8 0v3a3 3 0 1 1-3-3h3Z",
}
export default function AgentIcon({ name, size = 16, style }: { name: AgentIconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "more" ? 4 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>
}
