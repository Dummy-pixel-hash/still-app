const TAU = Math.PI * 2
const MAX_PARTICLES = 12000
const MAX_BACKING_PIXELS = 900_000
const GAS_HEIGHT = 56
const DUST_INK = ["rgba(218,53,83,.2)", "rgba(242,75,108,.32)", "rgba(255,123,149,.45)", "rgba(255,196,208,.65)"]

function randomSequence(seed: number) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    return seed / 4294967296
  }
}

// A small, fixed lattice: interpolating it avoids random allocation and expensive
// per-pixel trigonometric noise during the gas pass.
const lattice = new Float32Array(256 * 256)
const noiseRandom = randomSequence(5729)
for (let i = 0; i < lattice.length; i++) lattice[i] = noiseRandom()

function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const tx = x - ix, ty = y - iy
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
  const row = (iy & 255) << 8, nextRow = ((iy + 1) & 255) << 8
  const col = ix & 255, nextCol = (ix + 1) & 255
  const a = lattice[row + col], b = lattice[row + nextCol]
  const c = lattice[nextRow + col], d = lattice[nextRow + nextCol]
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}

type Dust = { x: Float32Array; spread: Float32Array; speed: Float32Array; size: Float32Array; groups: number[][] }

function makeDust(count: number): Dust {
  const random = randomSequence(9341)
  const dust: Dust = { x: new Float32Array(count), spread: new Float32Array(count), speed: new Float32Array(count), size: new Float32Array(count), groups: [[], [], [], []] }
  for (let i = 0; i < count; i++) {
    dust.x[i] = random()
    const gaussian = Math.sqrt(-2 * Math.log(Math.max(random(), .0001))) * Math.cos(TAU * random())
    dust.spread[i] = Math.max(-2.2, Math.min(2.2, gaussian * (i % 4 ? .48 : .95)))
    dust.speed[i] = 4 + random() * 10
    dust.size[i] = .45 + random() ** 3 * 1.35
    const group = random() < .76 ? Math.floor(random() * 2) : 2 + Math.floor(random() * 2)
    dust.groups[group].push(i)
  }
  return dust
}

/** Bounded 2D rendering: a tiny cached gas pass, plus four batched dust fills. */
export function createAuroraRenderer(canvas: HTMLCanvasElement, options: { maxParticles?: number } = {}) {
  const maxParticles = Math.min(MAX_PARTICLES, Math.max(1, options.maxParticles ?? MAX_PARTICLES))
  const context = canvas.getContext("2d")
  if (!context) return null
  const gas = document.createElement("canvas")
  const gasContext = gas.getContext("2d")
  if (!gasContext) return null
  let width = 0, height = 0, count = 0, lastGasTime = -Infinity
  let sceneWidth = 0, crop = 0
  let dust = makeDust(0), image: ImageData | null = null

  const drawGas = (time: number) => {
    if (!image) return
    const data = image.data, gw = gas.width
    const drift = time * .035
    for (let x = 0; x < gw; x++) {
      const u = (x / (gw - 1) * width + crop) / sceneWidth
      const wave = .055 * Math.sin(u * 6.8 + time * .17) + .03 * Math.sin(u * 15.6 - time * .14)
      for (let y = 0; y < GAS_HEIGHT; y++) {
        const v = y / (GAS_HEIGHT - 1)
        const warp = noise(u * 4.4 - drift, v * 3.2 + drift * .6)
        const warpedV = v + (warp - .5) * .22
        const texture = noise(u * 10 - drift * 1.8 + warp * 1.6, warpedV * 16 + drift * .7)
        const detail = noise(u * 22 + texture * 2, warpedV * 32 - drift)
        const dist = v - .52 - wave + (warp - .5) * .22 + (texture - .5) * .045
        const spread = .07 + warp * .07
        const body = Math.exp(-dist * dist / (spread * spread))
        const folds = .14 + texture * texture * .72 + detail * .14
        const veil = Math.exp(-dist * dist / .035) * .035
        const density = Math.min(.48, body * folds * .48 + veil)
        const offset = (y * gw + x) * 4
        data[offset] = 212 + texture * 37
        data[offset + 1] = 43 + detail * 28
        data[offset + 2] = 73 + texture * 32
        data[offset + 3] = density * 255
      }
    }
    gasContext.putImageData(image, 0, 0)
    lastGasTime = time
  }

  return {
    resize(nextWidth: number, nextHeight: number, pixelRatio = 1) {
      width = Math.max(1, nextWidth)
      height = Math.max(1, nextHeight)
      sceneWidth = Math.max(width, 1100)
      crop = (sceneWidth - width) / 2
      const scale = Math.min(pixelRatio || 1, 1.25, Math.sqrt(MAX_BACKING_PIXELS / (width * height)))
      canvas.width = Math.max(1, Math.floor(width * scale))
      canvas.height = Math.max(1, Math.floor(height * scale))
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.imageSmoothingEnabled = true
      gas.width = Math.min(176, Math.max(96, Math.round(width / 8)))
      gas.height = GAS_HEIGHT
      image = gasContext.createImageData(gas.width, gas.height)
      const nextCount = Math.min(maxParticles, Math.max(Math.min(3600, maxParticles), Math.round(width * 8)))
      if (nextCount !== count) {
        count = nextCount
        dust = makeDust(count)
      }
      lastGasTime = -Infinity
    },
    draw(time: number) {
      if (!width || !height) return
      context.clearRect(0, 0, width, height)
      // Gas is low-frequency: refresh at 15fps, not at device resolution or 60fps.
      if (time - lastGasTime >= 1 / 15 || time < lastGasTime) drawGas(time)
      context.drawImage(gas, 0, 0, width, height)
      for (let group = 0; group < dust.groups.length; group++) {
        context.beginPath()
        for (const index of dust.groups[group]) {
          const x = (dust.x[index] * width + time * dust.speed[index]) % width
          const u = (x + crop) / sceneWidth
          const spread = dust.spread[index]
          const wave = .055 * Math.sin(u * 6.8 + time * .17) + .03 * Math.sin(u * 15.6 - time * .14)
          const curl = u * 17 - time * .22 + spread * .9
          const dx = Math.cos(curl) * spread * height * .035
          const y = (.52 + wave) * height + spread * height * .14 + Math.sin(curl) * height * .026
          const size = dust.size[index]
          context.rect(x + dx, y, size, size)
        }
        context.fillStyle = DUST_INK[group]
        context.fill()
      }
    },
    metrics() {
      return { particles: count, gasWidth: gas.width, gasHeight: gas.height, backingPixels: canvas.width * canvas.height }
    },
  }
}
