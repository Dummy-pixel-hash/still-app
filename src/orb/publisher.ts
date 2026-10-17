import { buildOrbRows, DEFAULT_ORB_PREFERENCES, OUTPUT_ACTIVE_MS, PUBLISH_HEARTBEAT_MS } from "./state.ts"
import type { OrbAction, OrbBridge, OrbPreferences, OrbSessionInput } from "./types"

export interface OrbPublisherState { pending: boolean; error: string | null }
interface PublisherDependencies {
  bridge: OrbBridge
  subscribeData(id: string, receive: (data: number[]) => void): () => void
  onAction(action: OrbAction): void
  onState(state: OrbPublisherState): void
  now?: () => number
}

/**
 * Main-window observer. Never parses or retains terminal bytes. One coalesced
 * metadata stream, independent of rAF (the workspace can be minimized).
 */
export class OrbPublisher {
  private deps: PublisherDependencies
  private now: () => number
  private preferences: OrbPreferences = { ...DEFAULT_ORB_PREFERENCES }
  private inputs: readonly OrbSessionInput[] = []
  private inputKey = ""
  private activity = new Map<string, number>()
  private subscriptions = new Map<string, { nativeId: string; stop: () => void }>()
  private actionStop: (() => void) | null = null
  private ready: Promise<void>
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private running = false
  private dirty = false
  private appliedKey: string | null = null
  private faultKey: string | null = null
  private fingerprint: string | null = null
  private lastPublished = 0
  private state: OrbPublisherState = { pending: false, error: null }

  constructor(deps: PublisherDependencies) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.ready = deps.bridge.subscribeOrbActions(action => {
      if (!this.disposed) deps.onAction(action)
    }).then(stop => {
      if (this.disposed) stop()
      else this.actionStop = stop
    })
    // The pump reports a failed subscription; prevent an early unhandled rejection.
    void this.ready.catch(() => {})
  }

  update(inputs: readonly OrbSessionInput[], preferences: OrbPreferences) {
    if (this.disposed) return
    const key = JSON.stringify([inputs, preferences])
    if (key === this.inputKey) return
    this.inputKey = key
    this.inputs = inputs
    this.preferences = { ...preferences }
    this.syncSubscriptions()
    if (preferences.enabled && this.timer === null) this.timer = setInterval(() => this.tick(), 1000)
    if (!preferences.enabled && this.timer !== null) { clearInterval(this.timer); this.timer = null }
    this.request()
  }

  private syncSubscriptions() {
    const wanted = new Map(this.preferences.enabled ? this.inputs
      .filter(input => input.nativeId && (input.connection === "connected" || input.connection === "connecting"))
      .map(input => [input.id, input.nativeId!] as const) : [])
    for (const [id, sub] of this.subscriptions) {
      if (wanted.get(id) === sub.nativeId) continue
      sub.stop()
      this.subscriptions.delete(id)
      this.activity.delete(id)
    }
    for (const [id, nativeId] of wanted) {
      if (this.subscriptions.has(id)) continue
      const sub = { nativeId, stop: () => {} }
      this.subscriptions.set(id, sub)
      sub.stop = this.deps.subscribeData(id, data => {
        if (this.disposed || this.subscriptions.get(id) !== sub || data.length === 0) return
        const now = this.now(), before = this.activity.get(id)
        this.activity.set(id, now)
        // First activity after quiet responds promptly; bursts just update a timestamp.
        if (before === undefined || now - before >= OUTPUT_ACTIVE_MS) this.request()
      })
    }
    if (!this.preferences.enabled) this.activity.clear()
  }

  /** Also usable by deterministic tests instead of waiting for a wall clock. */
  tick() { if (this.preferences.enabled) this.request() }

  retry() {
    this.faultKey = null
    this.appliedKey = null
    // A subscription failure needs a new publisher; the UI recreates it on retry.
    this.request()
  }

  private report(pending: boolean, error: string | null) {
    if (this.disposed || (pending === this.state.pending && error === this.state.error)) return
    this.state = { pending, error }
    this.deps.onState(this.state)
  }

  private request() {
    if (this.disposed) return
    this.dirty = true
    if (!this.running) queueMicrotask(() => { void this.flush() })
  }

  private async flush() {
    if (this.running || this.disposed || !this.dirty) return
    this.running = true
    this.dirty = false
    const preferences = { ...this.preferences }
    const preferenceKey = JSON.stringify(preferences)
    try {
      if (this.faultKey === preferenceKey) return
      await this.ready
      if (this.disposed) return
      this.report(this.appliedKey !== preferenceKey, null)
      if (!preferences.enabled) {
        if (this.appliedKey !== preferenceKey) await this.deps.bridge.orbConfigure(preferences)
        if (this.disposed) return
        this.appliedKey = preferenceKey
        this.fingerprint = null
        this.lastPublished = 0
      } else {
        const now = this.now()
        const rows = buildOrbRows(this.inputs, this.activity, now)
        const fingerprint = JSON.stringify(rows)
        if (fingerprint !== this.fingerprint || now - this.lastPublished >= PUBLISH_HEARTBEAT_MS || this.appliedKey !== preferenceKey) {
          await this.deps.bridge.orbPublish(rows)
          if (this.disposed) return
          this.fingerprint = fingerprint
          this.lastPublished = now
        }
        // A toggle while publish was in flight supersedes this enable before it can show a window.
        if (JSON.stringify(this.preferences) !== preferenceKey) { this.dirty = true; return }
        if (this.appliedKey !== preferenceKey) await this.deps.bridge.orbConfigure(preferences)
        if (this.disposed) return
        this.appliedKey = preferenceKey
      }
      this.faultKey = null
      this.report(false, null)
    } catch {
      // Native messages may contain platform paths. Keep this small and actionable.
      this.faultKey = preferenceKey
      this.report(false, "The orb companion could not be updated. Retry, or turn it off and continue in Still.")
    } finally {
      this.running = false
      if (this.dirty && !this.disposed) queueMicrotask(() => { void this.flush() })
    }
  }

  dispose() {
    this.disposed = true
    if (this.timer !== null) clearInterval(this.timer)
    this.actionStop?.()
    this.subscriptions.forEach(sub => sub.stop())
    this.subscriptions.clear()
    this.activity.clear()
  }
}
