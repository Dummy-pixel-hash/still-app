import type { OrbBridge, OrbSnapshot } from "./types"

/** Event-first initialization, with revision ordering and late-listener cleanup. */
export function watchOrbSnapshot(
  bridge: Pick<OrbBridge, "subscribeOrbSnapshot" | "orbSnapshot">,
  receive: (snapshot: OrbSnapshot) => void,
  fail: (error: unknown) => void,
): () => void {
  let live = true
  let unlisten: (() => void) | undefined
  let revision = -1
  const deliver = (snapshot: OrbSnapshot) => {
    if (!live || snapshot.revision < revision) return
    revision = snapshot.revision
    receive(snapshot)
  }
  void bridge.subscribeOrbSnapshot(deliver).then(async (stop) => {
    if (!live) { stop(); return }
    unlisten = stop
    deliver(await bridge.orbSnapshot())
  }).catch(error => { if (live) fail(error) })
  return () => { live = false; unlisten?.() }
}
