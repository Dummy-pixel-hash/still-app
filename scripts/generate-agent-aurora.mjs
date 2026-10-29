import { writeFileSync } from "node:fs"

// Generate a fixed particle cloud, not a stroked line or a full-screen starfield.
// The seed keeps screenshots, blur sampling, and the shipped asset deterministic.
let seed = 4819
const random = () => {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
  return seed / 4294967296
}
const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), .0001))) * Math.cos(2 * Math.PI * random())
const spine = x => 185 + 22 * Math.sin(x / 218) + 11 * Math.sin(x / 113 + .7)
const point = (x, y, radius, opacity, color) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${color}" opacity="${opacity.toFixed(3)}"/>`

const haze = Array.from({ length: 85 }, (_, index) => {
  const x = index / 84 * 1660 - 30
  return point(x, spine(x) + normal() * 20, 18 + random() * 16, .08 + random() * .1, "#ed3655")
}).join("\n")

const particles = Array.from({ length: 1100 }, (_, index) => {
  const x = random() * 1680 - 40
  const distance = normal() * (index < 720 ? 12 + random() * 13 : 30 + random() * 35)
  const y = spine(x) + distance
  const falloff = Math.exp(-Math.abs(distance) / 62)
  const opacity = (.25 + random() * .65) * falloff
  const radius = .5 + random() ** 2 * 1.7
  const color = index % 9 === 0 ? "#ffd1d5" : index % 3 === 0 ? "#ff8b9a" : "#f4506b"
  return point(x, y, radius, opacity, color)
}).join("\n")

writeFileSync(new URL("../public/agents/particle-aurora.svg", import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 360" fill="none">
  <defs>
    <filter id="dust-haze" x="-30%" y="-150%" width="160%" height="400%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <g filter="url(#dust-haze)">${haze}</g>
  <g>${particles}</g>
</svg>\n`)
console.log("Generated particle-aurora.svg: 1100 particles + 85 diffuse dust clusters; no paths or strokes.")
