import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Still production bootstrap — clean Vite config.
// No prototype/Figma tooling. Dev server port matches src-tauri devUrl.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  server: {
    host: true,
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
  },
})
