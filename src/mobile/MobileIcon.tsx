export type MobileIconName = "agents" | "terminal" | "settings" | "search" | "folder" | "plus" | "back" | "chevron" | "close" | "check" | "more" | "key" | "server" | "arrow-up" | "arrow-down" | "arrow-left" | "arrow-right" | "keyboard" | "paste"
const paths: Record<MobileIconName, string> = {
  agents: "M7 4h10a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-3l-5 4v-4H7a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4ZM8 9h8m-8 4h4",
  terminal: "M9 4H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h3m6-16h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3M8 8l4 4-4 4m6 0h3",
  settings: "M7 3v4m0 5v9m10-18v9m0 5v4M6.5 7h1a2.5 2.5 0 0 1 0 5h-1a2.5 2.5 0 0 1 0-5Zm10 5h1a2.5 2.5 0 0 1 0 5h-1a2.5 2.5 0 0 1 0-5Z",
  search: "M16 16l5 5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  plus: "M12 5v14M5 12h14", back: "m12 5-7 7 7 7M5 12h15", chevron: "m9 6 6 6-6 6", close: "m6 6 12 12M6 18 18 6", check: "m5 12 4 4L19 6", more: "M5 12h.01M12 12h.01M19 12h.01",
  key: "M12 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0Zm-2 4 10 10m-5-5 3-3m0 6 3-3",
  server: "M5 3h14v7H5ZM5 14h14v7H5ZM8 6.5h.01M8 17.5h.01M12 6.5h4m-4 11h4",
  "arrow-up": "m5 12 7-7 7 7M12 5v15", "arrow-down": "m5 12 7 7 7-7M12 4v15", "arrow-left": "m12 5-7 7 7 7M5 12h15", "arrow-right": "m12 5 7 7-7 7M4 12h15",
  keyboard: "M3 5h18v14H3ZM7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h.01M15 13h.01M7 16h10",
  paste: "M5 5h14v16H5ZM9 2h6v6H9Z",
}
export default function MobileIcon({ name, size = 22 }: { name: MobileIconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "more" ? 3 : 1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
