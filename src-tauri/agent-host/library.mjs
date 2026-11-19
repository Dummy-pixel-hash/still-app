// Compatibility entrypoint. Shared discovery and mutation use the same validated
// account identity and private-record implementation.
import { discoverLibrary } from "./shared-library.mjs"
export { discoverLibrary }

const listIndex = process.argv[1] === "list" ? 1 : process.argv[2] === "list" ? 2 : -1
if (listIndex !== -1) {
  const options = JSON.parse(Buffer.from(process.argv[listIndex + 1] || "e30=", "base64").toString("utf8"))
  console.log("STILL_LIBRARY:" + JSON.stringify(discoverLibrary(process.env.HOME, options.after, options.limit || 100)))
}
