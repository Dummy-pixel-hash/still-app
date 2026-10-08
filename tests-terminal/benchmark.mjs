import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { ByteRing } from '../src/session/byteRing.ts'

// Comparable output-cache workload; not a claim about remote network latency.
const cap = 65536, count = 20000
const chunk = Array.from({length:256}, (_,i)=>i)
const old = []
let start = performance.now()
for (let i=0; i<count; i++) { old.push(...chunk); if(old.length>cap) old.splice(0,old.length-cap) }
const oldMs = performance.now()-start
const ring = new ByteRing(cap)
start = performance.now()
for (let i=0; i<count; i++) ring.append(chunk)
const newMs = performance.now()-start
assert.deepEqual([...ring.snapshot()], old)
console.log(JSON.stringify({chunks:count, bytes:count*chunk.length, oldArrayMs:+oldMs.toFixed(2), byteRingMs:+newMs.toFixed(2), ratio:+(oldMs/newMs).toFixed(2)}, null, 2))
