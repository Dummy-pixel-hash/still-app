import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOrbPreferences, buildOrbRows, describeOrbRow, orbSummary, emptyOrbSnapshot, sortOrbRows, clampOrbPosition, MAX_ORB_ROWS } from '../src/orb/state.ts'
import { watchOrbSnapshot } from '../src/orb/subscription.ts'
import { OrbPublisher } from '../src/orb/publisher.ts'
import { failingBridge } from '../src/bridge/nativeBridge.ts'

const input = (patch = {}) => ({ id: 's-one', name: 'Fixture session', nativeId: 'native-1', connection: 'connected', attention: null, changedAt: 100, ...patch })
const prefs = (enabled = true) => ({ enabled, size: 64, paused: false })
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function harness(overrides = {}) {
  let time = 10000
  const calls = [], states = [], handlers = new Map(), stopped = []
  const bridge = {
    async orbConfigure(p) { calls.push(['configure', { ...p }]); return { ...emptyOrbSnapshot(), preferences: p } },
    async orbPublish(rows) { calls.push(['publish', structuredClone(rows)]) },
    async subscribeOrbActions() { return () => stopped.push('actions') },
    ...overrides,
  }
  const publisher = new OrbPublisher({ bridge, now: () => time,
    subscribeData(id, fn) { handlers.set(id, fn); return () => { handlers.delete(id); stopped.push(id) } },
    onAction() {}, onState(state) { states.push(state) },
  })
  return { publisher, calls, handlers, stopped, states, setTime: value => { time = value }, rows: () => calls.filter(c => c[0] === 'publish').at(-1)?.[1] }
}

test('orb settings default off; nested partial/corrupt/legacy values cannot enable it', () => {
  for (const v of [null, undefined, 3, { enabled: 'true', size: 176 }, { orbEnabled: true }]) assert.deepEqual(normalizeOrbPreferences(v), prefs(false))
  assert.deepEqual(normalizeOrbPreferences({ enabled: true, size: 48, paused: true, token: 'ignored' }), { enabled: true, size: 48, paused: true })
  assert.equal(normalizeOrbPreferences({ size: 96 }).size, 96)
})

test('a connection is not an agent verdict; activity expires to unknown, never done', () => {
  const row = buildOrbRows([input()], new Map(), 10000)[0]
  assert.equal(describeOrbRow(row, 10000).visual, 'unknown')
  const active = buildOrbRows([input()], new Map([['s-one', 9990]]), 10000)[0]
  assert.equal(describeOrbRow(active, 10000).label, 'Output active')
  assert.equal(describeOrbRow(active, 12990).visual, 'unknown')
  assert.equal(describeOrbRow(active, 9000).visual, 'unknown')
  assert.equal(buildOrbRows([input({ connection: 'disconnected' })], new Map([['s-one', 9990]]), 10000).length, 0)
})

test('real auth and host-key prompts take priority, including before an SSH connection exists', () => {
  const rows = buildOrbRows([
    input({ id: 'normal' }), input({ id: 'error', connection: 'error' }),
    input({ id: 'auth', nativeId: null, connection: 'disconnected', attention: 'auth' }),
    input({ id: 'changed', attention: 'host-key-changed' }), input({ id: 'host', attention: 'host-key' }),
  ], new Map(), 10000)
  assert.deepEqual(rows.map(r => r.sessionId), ['auth', 'host', 'changed', 'error', 'normal'])
  assert.equal(describeOrbRow(rows[0], 10000).label, 'Sign-in required')
  assert.equal(describeOrbRow(rows[2], 10000).visual, 'error')
  assert.deepEqual(sortOrbRows([...rows].reverse(), 10000), rows)
})

test('snapshots whitelist bounded metadata, de-duplicate ids and ignore invalid ids', () => {
  const rows = buildOrbRows([input({ name: '\u001bsecret\nlabel', secret: 'password-must-not-travel', transcript: 'must-not-travel' }), input(), input({ id: 'bad:id' })], new Map(), 10000)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'secret label')
  assert.equal(JSON.stringify(rows).includes('must-not-travel'), false)
  assert.equal(buildOrbRows(Array.from({ length: 200 }, (_, i) => input({ id: `s-${i}`, name: 'x'.repeat(1000) })), new Map(), 10000).length, MAX_ORB_ROWS)
  assert.equal(buildOrbRows([input({ name: '😀'.repeat(150) })], new Map(), 10000)[0].name.length, 200)
})

test('absent or stale publication is distinct from an empty fresh workspace', () => {
  const snap = emptyOrbSnapshot()
  assert.equal(orbSummary(snap, 100).label, 'Waiting for Still')
  snap.publishedAt = 100
  assert.equal(orbSummary(snap, 101).label, 'No active connections')
  snap.rows = buildOrbRows([input()], new Map([['s-one', 15000]]), 15001)
  assert.equal(orbSummary(snap, 15101).label, 'Status unavailable')
  assert.equal(orbSummary(snap, 15101).row, null)
})

test('browser placement clamps every size and non-finite positions', () => {
  for (const size of [48, 64, 96]) {
    const a = clampOrbPosition(Infinity, NaN, 320, 600, size)
    const b = clampOrbPosition(5000, 5000, 320, 600, size)
    assert.ok(a.x >= 0 && a.y >= 0)
    assert.ok(b.x + size < 320 && b.y + size < 600)
  }
})

test('event-before-snapshot subscription never overwrites a newer event with stale initial data', async () => {
  const initial = deferred(), seen = []
  let deliver, stops = 0
  const stop = watchOrbSnapshot({
    async subscribeOrbSnapshot(fn) { deliver = fn; return () => stops++ },
    orbSnapshot() { return initial.promise },
  }, snap => seen.push(snap.revision), error => { throw error })
  await turn()
  deliver({ ...emptyOrbSnapshot(), revision: 3 })
  initial.resolve({ ...emptyOrbSnapshot(), revision: 2 })
  await turn()
  assert.deepEqual(seen, [3])
  stop()
  deliver({ ...emptyOrbSnapshot(), revision: 4 })
  assert.deepEqual(seen, [3])
  assert.equal(stops, 1)
})

test('unmount before async subscription resolves still removes the listener', async () => {
  const listen = deferred()
  let stops = 0, reads = 0
  const stop = watchOrbSnapshot({ subscribeOrbSnapshot: () => listen.promise, async orbSnapshot() { reads++; return emptyOrbSnapshot() } }, () => assert.fail('disposed subscriber ran'), () => assert.fail('disposed subscriber reported error'))
  stop(); listen.resolve(() => stops++)
  await turn()
  assert.equal(stops, 1); assert.equal(reads, 0)
})

test('publisher is opt-in, coalesces bursts, clears activity on expiry/removal/disable', async () => {
  const h = harness()
  try {
    h.publisher.update([input()], prefs(false)); await turn()
    assert.equal(h.handlers.size, 0)
    assert.deepEqual(h.calls.map(c => c[0]), ['configure'])
    h.publisher.update([input()], prefs()); await turn()
    assert.deepEqual(h.calls.slice(-2).map(c => c[0]), ['publish', 'configure'])
    assert.equal(h.handlers.size, 1)
    const receive = h.handlers.get('s-one')
    const before = h.calls.length
    for (let i = 0; i < 1000; i++) receive([27, 91, 109])
    await turn()
    assert.equal(h.calls.length, before + 1)
    assert.equal(h.rows()[0].lastOutputAt, 10000)
    h.setTime(13001); h.publisher.tick(); await turn()
    assert.equal(h.rows()[0].lastOutputAt, null)
    h.publisher.update([], prefs()); await turn()
    assert.deepEqual(h.rows(), [])
    assert.equal(h.handlers.size, 0)
    receive([1, 2]); await turn()
    assert.deepEqual(h.rows(), [])
    h.publisher.update([], prefs(false)); await turn()
    assert.equal(h.calls.at(-1)[1].enabled, false)
  } finally { h.publisher.dispose() }
  assert.ok(h.stopped.includes('actions'))
})

test('reconnect drops old activity and ignores a superseded data callback', async () => {
  const h = harness()
  try {
    h.publisher.update([input()], prefs()); await turn()
    const old = h.handlers.get('s-one'); old([1]); await turn()
    h.publisher.update([input({ nativeId: 'native-2' })], prefs()); await turn()
    assert.equal(h.rows()[0].lastOutputAt, null)
    old([1]); h.publisher.tick(); await turn()
    assert.equal(h.rows()[0].lastOutputAt, null)
    h.handlers.get('s-one')([1]); await turn()
    assert.equal(h.rows()[0].lastOutputAt, 10000)
  } finally { h.publisher.dispose() }
})

test('rapid enable/disable while publication awaits cannot show an obsolete orb', async () => {
  const publish = deferred(), configurations = []
  const h = harness({ orbPublish: () => publish.promise, async orbConfigure(p) { configurations.push(p.enabled); return emptyOrbSnapshot() } })
  try {
    h.publisher.update([], prefs(false)); await turn()
    h.publisher.update([input()], prefs()); await turn()
    h.publisher.update([input()], prefs(false))
    publish.resolve(); await turn()
    assert.deepEqual(configurations, [false])
  } finally { h.publisher.dispose() }
})

test('disposed publisher never enables after its in-flight publication resolves', async () => {
  const publish = deferred(), configurations = []
  const h = harness({ orbPublish: () => publish.promise, async orbConfigure(p) { configurations.push(p); return emptyOrbSnapshot() } })
  h.publisher.update([input()], prefs()); await turn()
  h.publisher.dispose(); publish.resolve(); await turn()
  assert.deepEqual(configurations, [])
})

test('native failure is actionable and not retried on every heartbeat', async () => {
  let calls = 0, fail = true
  const h = harness({ async orbConfigure() { calls++; if (fail) throw new Error('native failed'); return emptyOrbSnapshot() } })
  try {
    h.publisher.update([], prefs()); await turn()
    assert.match(h.states.at(-1).error, /Retry/)
    h.publisher.tick(); h.publisher.tick(); await turn()
    assert.equal(calls, 1)
    fail = false; h.publisher.retry(); await turn()
    assert.equal(calls, 2); assert.equal(h.states.at(-1).error, null)
  } finally { h.publisher.dispose() }
})

test('production without a native runtime cannot silently simulate any orb operation', async () => {
  for (const method of ['orbConfigure', 'orbPublish', 'orbSnapshot', 'subscribeOrbSnapshot', 'subscribeOrbActions', 'orbCommand']) {
    await assert.rejects(() => failingBridge[method](), /No native runtime/)
  }
})
