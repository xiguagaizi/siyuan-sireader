// Builds the actual reader component and uses the pinned snippet/PDFium runtime.
// The SiYuan host storage boundary is substituted by nativeReflow.fixture.mjs.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import '../tests/browser/nativeReflow.fixture.mjs'
import * as mupdf from 'mupdf'
// Mixed page sizes, including a page with intrinsic PDF rotation.
const fixtureDoc = new mupdf.PDFDocument(), fixtureFont = new mupdf.Font('Helvetica')
const fixtureResources = { Font: { F1: fixtureDoc.addSimpleFont(fixtureFont, 'Latin') } }
for (const [index, [width, height]] of [[600, 800], [900, 600], [420, 650]].entries()) {
  let text = `BT /F1 12 Tf 40 ${height - 60} Td `
  for (let line = 0; line < 30; line++) text += (line ? '0 -18 Td ' : '') + `(Native reader paragraph ${index} ${line} continues with readable text.) Tj `
  fixtureDoc.insertPage(-1, fixtureDoc.addPage([0, 0, width, height], index === 1 ? 90 : 0, fixtureResources, text + ' ET'))
}
const fixtureBytes = fixtureDoc.saveToBuffer('')
fs.writeFileSync('tmp/native-browser/source.pdf', fixtureBytes.asUint8Array())
fixtureBytes.destroy(); fixtureFont.destroy(); fixtureDoc.destroy()
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright')
const { chromium } = playwright.default || playwright
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost').pathname
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const file = url.startsWith('/plugins/siyuan-sireader/') ? path.resolve('dist', url.slice('/plugins/siyuan-sireader/'.length)) : url === '/source.pdf' ? path.resolve('tmp/native-browser/source.pdf') : path.resolve('tmp/native-browser/build', url === '/' ? 'index.html' : url.slice(1))
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) })
const page = await browser.newPage({ viewport: { width: 1000, height: 850 }, hasTouch: true })
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', error => { errors.push(error.message); console.log('PAGEERROR', error.message) })
page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE', message.text().slice(0, 250)) })
const annotations = () => page.evaluate(() => window.registry.getPlugin('annotation').provides().forDocument('sireader-document').getAnnotations().map(a => a.object))
const managed = async () => (await annotations()).filter(a => a.custom?.sireaderHandwriting)
const waitSavedCount = count => page.waitForFunction(count => (window.records['original-record'] || []).filter(a => a.annotation.custom?.sireaderHandwriting).length === count, count, { timeout: 15000 })
const enter = async () => {
  await page.waitForFunction(() => !window.registry.getPlugin('commands').provides().resolve('sireader:handwriting').disabled)
  await page.getByRole('button', { name: '手写笔记', exact: true }).click()
  await page.locator('.handwriting-toolbar').waitFor()
  if (process.env.HANDWRITING_ENTRY_DELAY_MS) await page.waitForTimeout(Number(process.env.HANDWRITING_ENTRY_DELAY_MS))
}
const cdp = await page.context().newCDPSession(page)
const pen = async (x, y, dx = 60, dy = 30) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: .5 })
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * i / 8, y: y + dy * i / 8, buttons: 1, pointerType: 'pen', force: .5 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
}
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, radiusX = 1, radiusY = 1], i) => ({ x, y, radiusX, radiusY, id: i + 1 })) })
const assertLastStrokeAt = async (x, y, dx = 60, dy = 30) => {
  const rect = await page.evaluate(({ x, y }) => {
    const r = window.registry, scroll = r.getPlugin('scroll').provides().forDocument('sireader-document')
    const a = r.getPlugin('annotation').provides().forDocument('sireader-document').getAnnotations().map(a => a.object).filter(a => a.custom?.sireaderHandwriting).at(-1)
    const projected = scroll.getRectPositionForPage(a.pageIndex, a.rect)
    let provider = document.querySelector('embedpdf-container').shadowRoot.elementFromPoint(x, y)
    for (; provider; provider = provider.parentElement) if (provider.style.touchAction === 'none' && provider.style.cursor === 'crosshair' && provider.clientWidth > 100) break
    if (!provider || !projected) return null
    const box = provider.getBoundingClientRect(), size = r.getPlugin('document-manager').provides().getDocument('sireader-document').pages[a.pageIndex].size
    const pageRect = scroll.getRectPositionForPage(a.pageIndex, { origin: { x: 0, y: 0 }, size })
    // The native viewport centers smaller pages in spare screen width. Anchor
    // to the actual PagePointerProvider rather than guessing that padding.
    return { x: box.left + projected.origin.x - pageRect.origin.x, y: box.top + projected.origin.y - pageRect.origin.y, width: projected.size.width, height: projected.size.height }
  }, { x, y })
  assert(rect)
  assert(Math.abs(rect.x - Math.min(x, x + dx)) < 8, JSON.stringify(rect))
  assert(Math.abs(rect.y - Math.min(y, y + dy)) < 8, JSON.stringify(rect))
  assert(Math.abs(rect.width - Math.abs(dx)) < 12, JSON.stringify(rect))
  assert(Math.abs(rect.height - Math.abs(dy)) < 12, JSON.stringify(rect))
}

try {
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.waitForFunction(() => window.ready?.length && window.readKeys?.length)
  await page.locator('.embed-pdf-reader__loading--overlay').waitFor({ state: 'hidden' })
  await page.evaluate(() => window.registry.getPlugin('annotation').provides().forDocument('sireader-document').createAnnotation(0, { id: 'original-ink', type: 15, pageIndex: 0, strokeColor: '#e44234', color: '#e44234', opacity: 1, strokeWidth: 2, flags: ['print'], created: new Date(), rect: { origin: { x: 80, y: 350 }, size: { width: 40, height: 20 } }, inkList: [{ points: [{ x: 81, y: 351 }, { x: 119, y: 369 }] }] }))
  await page.waitForFunction(() => window.records['original-record']?.some(a => a.annotation.id === 'original-ink'))
  await enter()
  assert.equal(await page.locator('.handwriting-toolbar__swatch').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(220, 38, 38)')
  const view = () => page.evaluate(() => ({ zoom: window.registry.getPlugin('zoom').provides().forDocument('sireader-document').getState().currentZoomLevel, top: window.registry.getPlugin('viewport').provides().forDocument('sireader-document').getMetrics().scrollTop }))
  const initialView = await view()
  // Reproduce the user's video: fingers support the hand, pen never touches.
  await touch('touchStart', [[650, 500], [680, 510]])
  await page.waitForTimeout(300)
  await touch('touchMove', [[620, 450], [750, 480]])
  await page.waitForTimeout(750)
  await touch('touchMove', [[600, 420], [780, 470]])
  await touch('touchEnd', [])
  assert.deepEqual(await view(), initialView); assert.equal((await managed()).length, 0)
  console.log('PALM SUPPORT WITHOUT PEN-DOWN: adjacent contacts ignored for full lifetime')
  // Native pen hover rejects even separated support contacts before pinch starts.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300, pointerType: 'pen', force: 0 })
  await touch('touchStart', [[600, 500], [800, 500]])
  await page.waitForTimeout(750)
  await touch('touchMove', [[550, 450], [850, 550]])
  await touch('touchEnd', [])
  assert.deepEqual(await view(), initialView); assert.equal((await managed()).length, 0)
  console.log('HOVER WITHOUT PEN-DOWN: support motion never starts native pinch')
  await page.waitForTimeout(750)
  await touch('touchStart', [[650, 500], [680, 510]])
  await pen(300, 240)
  await waitSavedCount(1)
  assert.equal((await managed())[0].strokeColor.toLowerCase(), '#dc2626')
  await assertLastStrokeAt(300, 240)
  await page.waitForTimeout(750)
  await touch('touchMove', [[620, 450], [780, 510]])
  await touch('touchEnd', [])
  assert.deepEqual(await view(), initialView)
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await waitSavedCount(0)
  console.log('PALM FIRST: pen ink preserved without pan/zoom drift')
  await pen(300, 240); await pen(420, 240)
  await waitSavedCount(2)
  assert.equal((await managed()).length, 2)
  assert.equal(await page.evaluate(() => window.registry.getPlugin('annotation').provides().forDocument('sireader-document').getSelectedAnnotation()), null)
  console.log('CONTINUOUS PEN saved', (await managed()).map(a => ({ id: a.id, rect: a.rect, points: a.inkList[0].points.length })))
  const beforeScroll = await page.evaluate(() => window.registry.getPlugin('viewport').provides().forDocument('sireader-document').getMetrics().scrollTop)
  await page.waitForTimeout(750)
  // Browser estimates can be broad even for an intentional finger gesture.
  // Shape alone must not block navigation; these are regression inputs, not
  // measurements of the user's iPad.
  await touch('touchStart', [[600, 500, 32, 30]])
  await page.waitForTimeout(120)
  const panSamples = []
  for (const y of [480, 460, 440, 420, 400, 380]) {
    await touch('touchMove', [[600, y, 32, 30]])
    panSamples.push(await page.evaluate(() => window.registry.getPlugin('viewport').provides().forDocument('sireader-document').getMetrics().scrollTop))
  }
  await touch('touchEnd', [])
  await page.waitForTimeout(250)
  const afterScroll = await page.evaluate(() => window.registry.getPlugin('viewport').provides().forDocument('sireader-document').getMetrics().scrollTop)
  assert(Math.abs(afterScroll - beforeScroll - 120) < 8, `finger scroll ${beforeScroll} -> ${afterScroll}`)
  assert(panSamples.every((value, index) => index === 0 || value >= panSamples[index - 1]), `pan jitter: ${panSamples}`)
  console.log('FINGER PAN monotonic fixed-origin movement:', panSamples)
  await touch('touchStart', [[600, 500]]); await touch('touchMove', [[600, 450]]); await touch('touchEnd', [])
  await page.waitForTimeout(100)
  const afterFlick = await page.evaluate(() => window.registry.getPlugin('viewport').provides().forDocument('sireader-document').getMetrics().scrollTop)
  assert(Math.abs(afterFlick - afterScroll - 50) < 8, `fast swipe ${afterScroll} -> ${afterFlick}`)
  console.log('FAST FINGER SWIPE preserved')

  assert.equal((await managed()).length, 2)
  const beforeZoom = await page.evaluate(() => window.registry.getPlugin('zoom').provides().forDocument('sireader-document').getState().currentZoomLevel)
  await touch('touchStart', [[350, 350, 32, 30], [550, 350, 32, 30]])
  await touch('touchMove', [[320, 350, 32, 30], [580, 350, 32, 30]]); await touch('touchMove', [[290, 350, 32, 30], [610, 350, 32, 30]]); await touch('touchEnd', [])
  await page.waitForTimeout(500)
  const afterZoom = await page.evaluate(() => window.registry.getPlugin('zoom').provides().forDocument('sireader-document').getState().currentZoomLevel)
  assert(afterZoom > beforeZoom + .1); console.log('PINCH zoom', beforeZoom, '->', afterZoom)
  assert.equal((await managed()).length, 2)
  // Restore the initial view before crossing the first stroke with an eraser.
  await page.evaluate(() => { window.registry.getPlugin('zoom').provides().forDocument('sireader-document').requestZoom('fit-width'); window.registry.getPlugin('viewport').provides().forDocument('sireader-document').scrollTo({ x: 0, y: 0 }) })
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '橡皮擦', exact: true }).click(); await page.waitForTimeout(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 330, y: 210, pointerType: 'pen' })
  assert(await page.locator('.handwriting-eraser-feedback').isVisible())
  await pen(330, 210, 0, 100)
  await waitSavedCount(1)
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await waitSavedCount(2)
  await page.getByRole('button', { name: '重做', exact: true }).click(); await waitSavedCount(1)
  console.log('ERASER saved; UNDO and REDO persisted')
  await page.getByRole('button', { name: '钢笔', exact: true }).click(); await page.waitForTimeout(100)
  await pen(300, 320)
  await page.getByRole('button', { name: '退出手写', exact: true }).click()
  await page.locator('.handwriting-toolbar').waitFor({ state: 'hidden' })
  const expected = await managed()
  const readyCount = await page.evaluate(() => window.ready.length)
  await page.evaluate(() => window.remountReader())
  await page.waitForFunction(count => window.ready.length > count, readyCount)
  await page.waitForFunction(() => window.registry.getPlugin('annotation').provides().forDocument('sireader-document').getAnnotations().filter(a => a.object.custom?.sireaderHandwriting).length === 2)
  assert((await annotations()).some(a => a.id === 'original-ink' && !a.custom?.sireaderHandwriting))
  const reopened = await managed()
  for (const a of reopened) { const old = expected.find(b => a.id === b.id); assert(old); assert.deepEqual(a.inkList, old.inkList); assert.deepEqual(a.rect, old.rect) }
  console.log('REOPEN geometry restored; no erased stroke resurrected')
  await enter()
  // Drawing through the same native page transform on a rotated, zoomed page.
  await page.evaluate(() => window.registry.getPlugin('rotate').provides().forDocument('sireader-document').setRotation(1))
  await page.waitForTimeout(250)
  await pen(300, 240)
  await waitSavedCount(3)
  await assertLastStrokeAt(300, 240)
  await page.evaluate(() => { window.registry.getPlugin('rotate').provides().forDocument('sireader-document').setRotation(0); window.registry.getPlugin('zoom').provides().forDocument('sireader-document').requestZoom(1.2) })
  await page.waitForTimeout(300)
  await pen(300, 270)
  await waitSavedCount(4)
  await assertLastStrokeAt(300, 270)
  await page.evaluate(() => window.registry.getPlugin('scroll').provides().forDocument('sireader-document').scrollToPage({ pageNumber: 2, behavior: 'instant' }))
  await page.waitForTimeout(350)
  await pen(300, 300)
  await waitSavedCount(5)
  await assertLastStrokeAt(300, 300)
  assert((await managed()).some(a => a.pageIndex === 1))
  const multiPageMarks = await managed()
  for (const mark of multiPageMarks) assert(mark.inkList.every(stroke => stroke.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))))
  console.log('ROTATION ZOOM MIXED PAGE drawing passed; original ink preserved')
  await page.getByRole('button', { name: '笔迹颜色', exact: true }).click()
  await page.getByRole('button', { name: '蓝色', exact: true }).click()
  await page.getByRole('button', { name: '笔迹颜色', exact: true }).click()
  assert.equal(await page.getByLabel('R', { exact: true }).inputValue(), '37')
  await page.getByLabel('R', { exact: true }).fill('40'); await page.getByLabel('R', { exact: true }).press('Tab')
  await page.getByLabel('HEX', { exact: true }).fill('#dc2626'); await page.getByLabel('HEX', { exact: true }).press('Tab')
  await page.screenshot({ path: 'tmp/native-browser/handwriting-colors.png' })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await page.waitForFunction(() => !!document.fullscreenElement?.classList.contains('embed-pdf-reader'))
  assert(await page.locator('.handwriting-toolbar').isVisible())
  await page.getByRole('button', { name: '退出全屏', exact: true }).click()
  await page.waitForFunction(() => !document.fullscreenElement)
  console.log('COMPACT COLOR panel and FULLSCREEN passed')
  await page.getByRole('button', { name: '荧光笔', exact: true }).click()
  await page.getByRole('button', { name: '笔迹粗细', exact: true }).click(); await page.getByRole('menuitemradio', { name: '3 pt', exact: true }).click()
  await pen(420, 380)
  await waitSavedCount(6)
  const highlighter = (await managed()).at(-1)
  assert(highlighter.opacity > 0 && highlighter.opacity < 1)
  assert.equal(highlighter.strokeWidth, 15)
  assert.equal(highlighter.strokeColor.toLowerCase(), '#dc2626')
  await page.getByRole('button', { name: '钢笔', exact: true }).click()
  await page.getByLabel('手指书写', { exact: true }).check()
  await page.waitForTimeout(750)
  await touch('touchStart', [[600, 500]]); await touch('touchMove', [[630, 520]]); await touch('touchEnd', [])
  await waitSavedCount(7)
  await page.getByLabel('手指书写', { exact: true }).uncheck()
  await page.getByRole('button', { name: '笔迹粗细', exact: true }).click(); await page.getByRole('menuitemradio', { name: '2 pt', exact: true }).click()
  console.log('HIGHLIGHTER width/opacity and FINGER opt-in passed')

  // The host uses the normal status bar layout; the reader adds no extra inset.
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 24, bottom: 20, left: 0, right: 0 } })
  await page.evaluate(() => {
    const original = HTMLElement.prototype.requestFullscreen
    window.restoreFullscreenAPI = () => { HTMLElement.prototype.requestFullscreen = original; delete navigator.standalone; window.dispatchEvent(new Event('resize')) }
    HTMLElement.prototype.requestFullscreen = undefined
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
    window.dispatchEvent(new Event('resize'))
  })
  await page.getByRole('button', { name: '展开阅读', exact: true }).waitFor()
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.embed-pdf-reader')).paddingTop) === 0)
  assert.equal((await page.locator('.handwriting-toolbar').boundingBox()).y, (await page.locator('.embed-pdf-reader').boundingBox()).y)
  // A host that already starts below the status bar must not gain another gap.
  await page.evaluate(() => { const app = document.getElementById('app'); app.style.marginTop = '40px'; app.style.height = '700px'; window.dispatchEvent(new Event('resize')) })
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.embed-pdf-reader')).paddingTop) === 0)
  await page.evaluate(() => { const app = document.getElementById('app'); app.style.marginTop = '0'; app.style.height = '760px'; window.dispatchEvent(new Event('resize')); window.readerBeforeExpand = window.registry })
  const originalBox = await page.locator('.embed-pdf-reader').boundingBox()
  await page.getByRole('button', { name: '展开阅读', exact: true }).click()
  await page.locator('.embed-pdf-reader--expanded').waitFor()
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.embed-pdf-reader')).paddingTop) === 0)
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), false)
  assert.equal(await page.evaluate(() => window.readerBeforeExpand === window.registry), true)
  const expandedBox = await page.locator('.embed-pdf-reader').boundingBox()
  assert.equal(expandedBox.width, 1000); assert.equal(expandedBox.height, 850)
  assert.equal((await page.locator('.handwriting-toolbar').boundingBox()).y, (await page.locator('.embed-pdf-reader').boundingBox()).y)
  await page.screenshot({ path: 'tmp/native-browser/handwriting-pwa-expanded.png' })
  await pen(400, 300); await waitSavedCount(8); await assertLastStrokeAt(400, 300)
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await waitSavedCount(7)
  await page.getByRole('button', { name: '恢复布局', exact: true }).click()
  await page.locator('.embed-pdf-reader--expanded').waitFor({ state: 'hidden' })
  assert.equal((await page.locator('.embed-pdf-reader').boundingBox()).width, originalBox.width)
  assert.equal(await page.locator('.embed-pdf-reader').getAttribute('popover'), null)
  await page.getByRole('button', { name: '展开阅读', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.locator('.embed-pdf-reader--expanded').waitFor({ state: 'hidden' })
  await page.evaluate(() => window.restoreFullscreenAPI())
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } })
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.getByRole('button', { name: '全屏', exact: true }).waitFor()
  console.log('PWA missing Fullscreen API: page expansion without additional safe-area padding, drawing and restore passed')


  await page.evaluate(() => { window.registry.getPlugin('scroll').provides().forDocument('sireader-document').scrollToPage({ pageNumber: 1, behavior: 'instant' }); window.registry.getPlugin('zoom').provides().forDocument('sireader-document').requestZoom('fit-width') })
  for (const [name, width, height] of [['desktop', 1000, 850], ['tablet', 820, 1180], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => { const app = document.getElementById('app'); app.style.width = '100vw'; app.style.height = '100vh' })
    await page.waitForTimeout(180)
    assert(await page.locator('.handwriting-toolbar__exit').isVisible())
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert(!overflow, `${name} overflow`)
    await page.screenshot({ path: `tmp/native-browser/handwriting-${name}.png` })
  }
  await page.getByRole('button', { name: '退出手写', exact: true }).click()
  await page.locator('.handwriting-toolbar').waitFor({ state: 'hidden' })
  await enter()
  console.log('MOBILE entry and mode restoration passed')
  // Reproduce writing over the native floating controls, including their
  // transparent hit area. The stylus must reach the actual page provider.
  await page.setViewportSize({ width: 1000, height: 850 })
  await page.evaluate(() => {
    const app = document.getElementById('app'); app.style.height = '100vh'
    window.registry.getPlugin('scroll').provides().forDocument('sireader-document').scrollToPage({ pageNumber: 1, behavior: 'instant' })
    window.registry.getPlugin('zoom').provides().forDocument('sireader-document').requestZoom('fit-width')
  })
  await page.getByRole('button', { name: '退出手写', exact: true }).click()
  const controls = page.locator('[data-overlay-id="page-controls"]')
  await page.waitForTimeout(250)
  const bottomBox = await controls.locator('.pointer-events-auto > div').boundingBox()
  assert(bottomBox)
  const bx = bottomBox.x + bottomBox.width / 2, by = bottomBox.y + bottomBox.height / 2
  await enter()
  assert.equal(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by, pointerType: 'pen', force: 0 })
  assert.equal(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  assert.equal(await page.evaluate(({ x, y }) => !!document.querySelector('embedpdf-container').shadowRoot.elementFromPoint(x, y)?.closest('[data-overlay-id="page-controls"]'), { x: bx, y: by }), false)
  const countBeforeBottom = (await managed()).length
  await pen(bx - 30, by, 60, -12)
  await waitSavedCount(countBeforeBottom + 1)
  await assertLastStrokeAt(bx - 30, by, 60, -12)
  assert.equal(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  // A rejected palm cannot switch the UI back to touch while the pen owns it.
  await touch('touchStart', [[bx + 100, by - 100]])
  assert.equal(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  await touch('touchEnd', [])
  await page.waitForTimeout(750)
  await touch('touchStart', [[600, 500]])
  await page.waitForTimeout(120)
  await touch('touchMove', [[600, 470]])
  await touch('touchEnd', [])
  assert.notEqual(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by, pointerType: 'pen', force: 0 })
  assert.equal(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  await page.mouse.move(900, 400)
  assert.notEqual(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  await page.getByRole('button', { name: '退出手写', exact: true }).click()
  assert.notEqual(await controls.evaluate(el => getComputedStyle(el).display), 'none')
  assert.equal(await page.locator('embedpdf-container').getAttribute('data-sireader-handwriting-input'), null)
  await enter()
  console.log('RED DEFAULT and BOTTOM CONTROLS: pen hover/ink pass through; palm stays hidden; touch/mouse and exit restore controls')
  assert.deepEqual(errors, [])
  assert.equal(await page.evaluate(() => window.messages.filter(a => a[2] === 'error').length), 0)
  console.log('PASS handwriting browser checks')
} finally {
  await page.screenshot({ path: 'tmp/native-browser/handwriting-final.png' })
  await browser.close(); server.close()
}
