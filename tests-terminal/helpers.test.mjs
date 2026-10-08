import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ByteRing } from '../src/session/byteRing.ts'
import { WheelSteps } from '../src/terminal/wheel.ts'
import { decodeClipboardRequest, MAX_REMOTE_COPY_BYTES } from '../src/terminal/clipboard.ts'

const encode = text => Buffer.from(text).toString('base64')

test('byte ring wraps, snapshots in order and tracks growth after reaching cap', () => {
  const ring = new ByteRing(5)
  ring.append([1, 2, 3]); const previous = ring.snapshot()
  ring.append([4, 5, 6, 7])
  assert.deepEqual([...ring.snapshot()], [3, 4, 5, 6, 7])
  assert.deepEqual([...previous], [1, 2, 3])
  assert.equal(ring.totalBytes, 7)
  ring.append(new Uint8Array([8, 9, 10, 11, 12, 13]))
  assert.deepEqual([...ring.snapshot()], [9, 10, 11, 12, 13])
  ring.append([14])
  assert.deepEqual([...ring.snapshot()], [10, 11, 12, 13, 14])
  assert.equal(ring.totalBytes, 14)
})

test('ring accepts chunks larger than JS spread argument limits', () => {
  const ring = new ByteRing()
  const data = Array.from({ length: 500000 }, (_, i) => i % 256)
  ring.append(data)
  assert.deepEqual([...ring.snapshot()], data.slice(-65536))
})

test('fractional pixel wheels accumulate, reversals/idle reset; line/page units work', () => {
  const steps = new WheelSteps()
  assert.equal(steps.consume(4, 0, 16, 20, 1), 0)
  assert.equal(steps.consume(4, 0, 16, 20, 2), 0)
  assert.equal(steps.consume(24, 0, 16, 20, 3), 2)
  assert.equal(steps.consume(8, 0, 16, 20, 4), 0)
  assert.equal(steps.consume(-16, 0, 16, 20, 5), -1)
  assert.equal(steps.consume(3, 1, 16, 20, 6), 3)
  assert.equal(steps.consume(1, 2, 16, 20, 7), 20)
  assert.equal(steps.consume(8, 0, 16, 20, 8), 0)
  assert.equal(steps.consume(8, 0, 16, 20, 1000), 0)
  assert.equal(steps.consume(Infinity, 0, 16, 20), 0)
  assert.equal(steps.consume(100000, 0, 16, 20), 32)
})

test('OSC52 accepts bounded Unicode writes, never reads, malformed or oversized data', () => {
  assert.equal(decodeClipboardRequest(`c;${encode('你好\nλ')}`), '你好\nλ')
  assert.equal(decodeClipboardRequest(`;${encode('text')}`), 'text')
  for (const invalid of ['c;?', 'p;?', 'c;', 'c;!!!', 'c;/w==', `p;${encode('text')}`, 'invalid']) {
    assert.equal(decodeClipboardRequest(invalid), null)
  }
  assert.equal(decodeClipboardRequest(`c;${encode('x'.repeat(MAX_REMOTE_COPY_BYTES + 1))}`), null)
})
