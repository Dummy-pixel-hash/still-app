import { nativeBridge } from "./nativeBridge"
import { normalizeExternalUrl } from "../terminal/links"

/**
 * Open a validated http(s) URL in the OS default browser.
 *
 * Returns false for anything that is not a safe external URL. Callers should
 * treat the boolean as "did we hand it to the opener", not as a guarantee that
 * a browser window appeared (the OS launch is asynchronous).
 */
export async function openExternalUrl(raw: string | null | undefined): Promise<boolean> {
  if (!raw) return false
  const url = normalizeExternalUrl(raw)
  if (!url) return false
  await nativeBridge.openExternal(url)
  return true
}
