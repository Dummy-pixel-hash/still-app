/** Measure high-frequency horizontal contrast in a captured PNG, not CSS values. */
export async function pixelContrast(page, image) {
  return page.evaluate(async base64 => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext("2d")
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let contrast = 0, samples = 0
    for (let y = 4; y < canvas.height - 4; y++) for (let x = 4; x < canvas.width - 4; x++) {
      const offset = (y * canvas.width + x) * 4
      contrast += Math.abs(data[offset] - data[offset - 4])
      samples++
    }
    return contrast / samples
  }, image.toString("base64"))
}

/** Probe the actual aurora canvas at its production depth, without inserting a
 * higher-z-index backdrop that could accidentally bypass a compositing defect. */
export async function probeAuroraGlass(page, capture, targetPanes = [["sidebar", ".agent-sidebar"], ["composer", ".agent-composer"]]) {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.locator('.agent-aurora[data-rendered="true"][data-paused="true"]').waitFor()
  await page.waitForFunction(() => {
    const source = document.querySelector(".agent-aurora canvas")
    return !source.dataset.frostManaged || source.dataset.frostFrame
  })
  await capture("normal", await page.screenshot({ animations: "disabled" }))
  const previousFrame = await page.evaluate(() => {
    const canvas = document.querySelector(".agent-aurora canvas")
    const context = canvas.getContext("2d")
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    for (let x = 0; x < canvas.width; x += 8) {
      context.fillStyle = (x / 8) % 2 ? "#eeeef4" : "#101014"
      context.fillRect(x, 0, 8, canvas.height)
    }
    context.restore()
    const previous = canvas.dataset.frostFrame
    canvas.dispatchEvent(new Event("still:backdrop-frame"))
    return previous
  })
  if (previousFrame !== undefined) await page.waitForFunction(previous => document.querySelector(".agent-aurora canvas").dataset.frostFrame !== previous, previousFrame)
  const hide = await page.addStyleTag({ content: ".agent-sidebar > *, .agent-recents > *, .agent-composer > * { visibility: hidden !important; }" })
  const source = await page.locator(".agent-aurora").boundingBox()
  if (!source) throw new Error("The production aurora is not visible")
  const panes = []
  for (const [name, selector] of targetPanes) {
    const bounds = await page.locator(selector).boundingBox()
    if (!bounds) throw new Error(`${name} is not visible`)
    const x = Math.ceil(Math.max(bounds.x, source.x) + 20)
    const y = Math.ceil(Math.max(bounds.y, source.y) + 20)
    const right = Math.floor(Math.min(bounds.x + bounds.width, source.x + source.width) - 20)
    const bottom = Math.floor(Math.min(bounds.y + bounds.height, source.y + source.height) - 20)
    if (right - x < 32 || bottom - y < 16) throw new Error(`${name} does not overlap the actual backdrop`)
    const clip = { x, y, width: Math.min(200, right - x), height: Math.min(24, bottom - y) }
    const image = await page.screenshot({ clip, animations: "disabled", scale: "css" })
    await capture(`${name}-blurred`, image)
    panes.push({ name, clip, contrast: await pixelContrast(page, image) })
  }
  const disable = await page.addStyleTag({ content: ".agent-workspace { --ag-frost-image: none !important; } .agent-sidebar, .agent-recents, .agent-composer::before { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }" })
  const results = []
  try {
    for (const pane of panes) {
      const image = await page.screenshot({ clip: pane.clip, animations: "disabled", scale: "css" })
      await capture(`${pane.name}-unblurred`, image)
      const unblurred = await pixelContrast(page, image)
      results.push({ name: pane.name, blurred: pane.contrast, unblurred, ratio: pane.contrast / unblurred })
    }
    return results
  } finally {
    await disable.evaluate(el => el.remove())
    await hide.evaluate(el => el.remove())
  }
}
