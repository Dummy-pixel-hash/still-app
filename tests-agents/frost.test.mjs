import test from "node:test"
import assert from "node:assert/strict"
import { blurOpaquePixels } from "../src/agents/glassBackdrop.ts"

test("scene blur preserves flat colors and opaque alpha", () => {
  const width = 32, height = 24, data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set([20, 35, 60, 255], i)
  const expected = data.slice()
  blurOpaquePixels(data, width, height, 6, new Uint8ClampedArray(data.length))
  assert.deepEqual(data, expected)
})

test("scene blur removes sharp detail rather than just reducing its opacity", () => {
  const width = 80, height = 24, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = x % 4 < 2 ? 16 : 240
    data.set([value, value, value, 255], (y * width + x) * 4)
  }
  blurOpaquePixels(data, width, height, 6, new Uint8ClampedArray(data.length))
  for (let x = 20; x < 60; x++) {
    const offset = (12 * width + x) * 4
    assert.ok(data[offset] > 110 && data[offset] < 145)
    assert.equal(data[offset + 3], 255)
  }
})

test("scene blur clamps edges without wrapping color around the scene", () => {
  const width = 80, height = 24, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x === 0 ? 255 : 0, 0, 0, 255], (y * width + x) * 4)
  blurOpaquePixels(data, width, height, 6, new Uint8ClampedArray(data.length))
  assert.ok(data[(12 * width) * 4] > 0)
  assert.equal(data[(12 * width + 79) * 4], 0)
})
