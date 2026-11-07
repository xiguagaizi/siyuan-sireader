// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createHandwritingSession, createHandwritingTools, HANDWRITING_TOOLS, hitsHandwriting, segmentsDistance } from '../src/handwriting/session'

afterEach(() => vi.useRealTimers())

const ink = (id = 'hand') => ({ type: 15, id, pageIndex: 0, strokeWidth: 2, custom: { sireaderHandwriting: 1 }, inkList: [{ points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] }] })
function fixture() {
  const host = document.createElement('div'), tools = new Map<string, any>(), objects: any[] = [], commits: any[] = []
  const commands: any[] = [], listeners = new Set<(event: any) => void>()
  let historyIndex = -1
  const changed = () => listeners.forEach(fn => fn('annotations'))
  const history = {
    register(command: any) { commands.splice(++historyIndex); commands.push(command); command.execute(); changed() },
    undo() { if (historyIndex >= 0) { commands[historyIndex--].undo(); changed() } },
    redo() { if (historyIndex + 1 < commands.length) { commands[++historyIndex].execute(); changed() } },
    onHistoryChange(fn: (event: any) => void) { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const historyState = vi.fn()
  let selected: any = { id: 'old-tool' }, lock: any = { type: 'none' }, mode = 'panMode'
  const scope = {
    getActiveTool: () => selected, setActiveTool: vi.fn((id: string) => { selected = id && (tools.get(id) || { id }); mode = id ? 'annotation:' + id : 'panMode' }),
    getLocked: () => lock, setLocked: (next: any) => { lock = next }, deselectAnnotation: vi.fn(),
    getAnnotations: () => objects.map(object => ({ object })), deleteAnnotations: vi.fn((items: any[]) => items.forEach(item => { const object = objects.find(a => a.id === item.id); if (object) history.register({ execute: () => objects.splice(objects.findIndex(a => a.id === item.id), 1), undo: () => objects.push(object) }) })),
    onActiveToolChange: () => vi.fn(),
  }
  const pointerHandler = { create: (context: any) => {
    let points: any[] = []
    return {
      onPointerDown: (pos: any, event: any) => { points = [pos]; event.setPointerCapture?.(); context.onPreview({ data: { ...context.getTool().defaults, inkList: [{ points }] } }) },
      onPointerMove: (pos: any) => { points.push(pos); context.onPreview({ data: { ...context.getTool().defaults, inkList: [{ points }] } }) },
      onPointerCancel: () => { points = []; context.onPreview(null) },
    }
  } }
  tools.set('ink', { id: 'ink', defaults: { type: 15, strokeWidth: 2 }, behavior: { commitDelay: 800 }, pointerHandler })
  tools.set('inkHighlighter', { ...tools.get('ink'), id: 'inkHighlighter', defaults: { type: 15, opacity: 1 } })
  const root = { forDocument: () => scope, getTool: (id: string) => tools.get(id), addTool: (tool: any) => tools.set(tool.id, tool), setToolDefaults: (id: string, defaults: any) => Object.assign(tools.get(id).defaults, defaults) }
  const metrics = { scrollLeft: 0, scrollTop: 200 }
  const viewport = { getMetrics: () => metrics, scrollTo: vi.fn((pos: any) => Object.assign(metrics, { scrollLeft: pos.x, scrollTop: pos.y })) }
  const interaction = { getActiveMode: () => mode, activate: (next: string) => { mode = next } }
  const caps: any = { history: { forDocument: () => history }, annotation: root, viewport: { forDocument: () => viewport }, 'interaction-manager': { forDocument: () => interaction } }
  const error = vi.fn()
  let session: ReturnType<typeof createHandwritingSession>
  createHandwritingTools(() => session).forEach(tool => root.addTool(tool))
  session = createHandwritingSession({ registry: { getPlugin: (id: string) => ({ provides: () => caps[id] }) }, documentId: 'test', host, onError: error, onHistoryChange: historyState })
  let handler: any
  const choose = (kind: 'pen' | 'eraser' | 'highlighter') => {
    session.setTool(kind)
    handler = tools.get(HANDWRITING_TOOLS[kind]).pointerHandler.create({ getTool: () => selected, pageIndex: 0, scale: 1, pageSize: { width: 600, height: 800 }, onPreview: vi.fn(), onCommit: (a: any) => { commits.push(a); history.register({ execute: () => objects.push(a), undo: () => objects.splice(objects.findIndex(o => o.id === a.id), 1) }) } })
  }
  const send = (type: string, pointerType: string, x: number, y: number, pointerId = 1, button = 0, geometry: { width?: number; height?: number } = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as any
    Object.assign(event, { pointerType, pointerId, clientX: x, clientY: y, button, ...geometry })
    const allowed = host.dispatchEvent(event)
    if (allowed) handler[({ pointerdown: 'onPointerDown', pointermove: 'onPointerMove', pointerup: 'onPointerUp', pointercancel: 'onPointerCancel' } as any)[type]]?.({ x, y }, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() }, '')
  }
  const touch = (type: string, points: number[][]) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as any
    Object.assign(event, { touches: points.map(([clientX, clientY, radiusX = 0, radiusY = 0, rotationAngle = 0], identifier) => ({ clientX, clientY, identifier, radiusX, radiusY, rotationAngle })) })
    return host.dispatchEvent(event)
  }
  session.enter(); choose('pen')
  return { host, session, scope, tools, commits, objects, choose, send, touch, viewport, error, history, historyState, mode: () => mode, lock: () => lock }
}

describe('stroke eraser geometry', () => {
  test('hits between points and along a fast eraser sweep', () => {
    expect(hitsHandwriting(ink(), { x: 50, y: 0 }, { x: 50, y: 100 }, 2)).toBe(true)
    expect(hitsHandwriting(ink(), { x: 50, y: 80 }, { x: 50, y: 100 }, 2)).toBe(false)
    expect(segmentsDistance({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 3, y: 1 }, { x: 8, y: 1 })).toBe(2)
  })
  test('protects original ink, highlights and document annotations', () => {
    expect(hitsHandwriting({ ...ink(), custom: {} }, { x: 0, y: 0 }, { x: 100, y: 100 }, 10)).toBe(false)
    expect(hitsHandwriting({ ...ink(), type: 9 }, { x: 0, y: 0 }, { x: 100, y: 100 }, 10)).toBe(false)
  })
})

test('consecutive pen strokes commit at pen-up without timers or tool changes', () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) { f.send('pointerdown', 'pen', i, 10); f.send('pointermove', 'pen', i + 3, 20); f.send('pointerup', 'pen', i + 5, 30) }
  expect(f.commits).toHaveLength(3)
  expect(new Set(f.commits.map(a => a.id)).size).toBe(3)
  expect(f.scope.getActiveTool().id).toBe(HANDWRITING_TOOLS.pen)
  expect(f.tools.get('ink').behavior.commitDelay).toBe(800)
  expect(f.error).not.toHaveBeenCalled()
})

test('finger scrolls without ink, and two fingers stop single-finger panning', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 10, 100, 2); vi.advanceTimersByTime(120); f.send('pointermove', 'touch', 10, 60, 2)
  expect(f.viewport.getMetrics().scrollTop).toBe(240)
  f.send('pointerdown', 'touch', 80, 100, 3); f.send('pointermove', 'touch', 10, 50, 2)
  expect(f.viewport.getMetrics().scrollTop).toBe(240)
  f.send('pointerup', 'touch', 10, 50, 2); f.send('pointerup', 'touch', 80, 100, 3)
  expect(f.commits).toHaveLength(0)
})

test('palm contact never moves the page or creates ink during a pen stroke', () => {
  const f = fixture()
  f.send('pointerdown', 'pen', 10, 10)
  f.send('pointerdown', 'touch', 20, 100, 2); f.send('pointermove', 'touch', 20, 30, 2)
  f.send('pointerup', 'pen', 30, 20); f.send('pointermove', 'touch', 20, 10, 2); f.send('pointerup', 'touch', 20, 10, 2)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  expect(f.commits).toHaveLength(1)
})

test('finger compatibility is explicit and a second finger cancels its draft', () => {
  const f = fixture(); f.session.setAllowTouch(true)
  f.send('pointerdown', 'touch', 0, 0, 2); f.send('pointerup', 'touch', 10, 10, 2)
  expect(f.commits).toHaveLength(1)
  f.send('pointerdown', 'touch', 0, 0, 2); f.send('pointerdown', 'touch', 30, 0, 3); f.send('pointerup', 'touch', 10, 10, 2)
  expect(f.commits).toHaveLength(1)
})

test('eraser deletes managed strokes directly and leaves original ink intact', () => {
  const f = fixture(); f.objects.push(ink(), { ...ink('original'), custom: {} }); f.choose('eraser')
  f.send('pointerdown', 'mouse', 50, 0); f.send('pointermove', 'mouse', 50, 100); f.send('pointerup', 'mouse', 50, 100)
  expect(f.objects.map(a => a.id)).toEqual(['original'])
  expect(f.scope.deleteAnnotations).toHaveBeenCalledWith([{ pageIndex: 0, id: 'hand' }])
})

test('cancel drops a draft; exit commits the last in-progress stroke and restores the old mode', () => {
  const f = fixture()
  f.send('pointerdown', 'mouse', 5, 5); f.send('pointercancel', 'mouse', 6, 6)
  expect(f.commits).toHaveLength(0)
  f.send('pointerdown', 'mouse', 5, 5); f.send('pointermove', 'mouse', 6, 6); f.session.exit()
  expect(f.commits).toHaveLength(1)
  expect(f.scope.getActiveTool().id).toBe('old-tool')
  expect(f.mode()).toBe('panMode'); expect(f.lock()).toEqual({ type: 'none' })
  f.session.dispose(); expect(f.error).not.toHaveBeenCalled()
})


test('lost pointer capture commits the last visible preview and clears pen contact', () => {
  const f = fixture()
  f.send('pointerdown', 'pen', 5, 5)
  f.send('pointermove', 'pen', 15, 15)
  const lost = new Event('lostpointercapture') as any
  Object.assign(lost, { pointerId: 1 })
  f.host.dispatchEvent(lost)
  expect(f.commits).toHaveLength(1)
  f.session.dispose()
  expect(f.commits).toHaveLength(1)
})

test('right mouse button does not create handwriting', () => {
  const f = fixture()
  f.send('pointerdown', 'mouse', 5, 5, 1, 2)
  f.send('pointerup', 'mouse', 15, 15, 1, 2)
  expect(f.commits).toHaveLength(0)
})

test('entry readiness follows the native page effect, after its event providers mount', async () => {
  const ready = vi.fn()
  const tool = createHandwritingTools(() => null, ready)[0]
  tool.pointerHandler.create({})
  expect(ready).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(ready).toHaveBeenCalledTimes(1)
})


test('highlighter has its own translucent defaults without changing native tools', () => {
  const f = fixture()
  f.session.setStyle('#ffe066', 3)
  f.choose('highlighter')
  f.send('pointerdown', 'mouse', 5, 5); f.send('pointerup', 'mouse', 15, 15)
  expect(f.commits[0]).toMatchObject({ opacity: .35, strokeWidth: 15, strokeColor: '#ffe066' })
  expect(f.tools.get('inkHighlighter').defaults.opacity).toBe(1)
})


test('LAN HTTP without randomUUID still creates distinct stroke IDs', () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  vi.stubGlobal('crypto', { getRandomValues })
  try {
    const f = fixture()
    for (let i = 0; i < 2; i++) { f.send('pointerdown', 'mouse', 5, 5); f.send('pointerup', 'mouse', 15, 15) }
    expect(f.commits).toHaveLength(2)
    expect(f.commits[0].id).toMatch(/^[0-9a-f]{32}$/)
    expect(f.commits[0].id).not.toBe(f.commits[1].id)
    expect(f.error).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})


test('undo/redo groups all strokes erased in one gesture and protects older native edits', () => {
  const f = fixture()
  f.history.register({ execute() {}, undo() { throw new Error('must not undo old native history') } })
  f.send('pointerdown', 'pen', 0, 40); f.send('pointerup', 'pen', 100, 40)
  f.send('pointerdown', 'pen', 0, 60); f.send('pointerup', 'pen', 100, 60)
  const ids = f.objects.map(a => a.id)
  f.choose('eraser')
  f.send('pointerdown', 'mouse', 50, 20); f.send('pointermove', 'mouse', 50, 80); f.send('pointerup', 'mouse', 50, 80)
  expect(f.objects).toHaveLength(0)
  f.session.undo(); expect(f.objects.map(a => a.id).sort()).toEqual([...ids].sort())
  f.session.redo(); expect(f.objects).toHaveLength(0)
  f.session.undo(); f.session.undo(); f.session.undo(); f.session.undo()
  expect(f.objects).toHaveLength(0)
  expect(f.historyState).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true })
  f.session.redo(); expect(f.objects).toHaveLength(1)
  f.choose('pen'); f.send('pointerdown', 'pen', 10, 100); f.send('pointerup', 'pen', 30, 100)
  expect(f.historyState).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false })
})

test('external/native history changes invalidate the handwriting gesture boundary', () => {
  const f = fixture()
  f.send('pointerdown', 'pen', 0, 40); f.send('pointerup', 'pen', 100, 40)
  f.history.undo()
  expect(f.historyState).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false })
  f.session.redo(); expect(f.objects).toHaveLength(0)
})

test('finger pan uses its initial origin even when viewport metrics have not updated', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.viewport.scrollTo.mockImplementation(() => {})
  f.send('pointerdown', 'touch', 10, 100, 2)
  vi.advanceTimersByTime(120)
  f.send('pointermove', 'touch', 10, 80, 2); f.send('pointermove', 'touch', 10, 50, 2)
  expect(f.viewport.scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 250, behavior: 'instant' })
  f.send('pointerdown', 'touch', 80, 100, 3); f.send('pointerup', 'touch', 80, 100, 3)
  const count = f.viewport.scrollTo.mock.calls.length
  f.send('pointermove', 'touch', 10, 30, 2)
  expect(f.viewport.scrollTo).toHaveBeenCalledTimes(count)
})

test('eraser ring and swept trail follow input and are removed on exit', () => {
  const f = fixture(); f.choose('eraser')
  f.send('pointerdown', 'mouse', 20, 30); f.send('pointermove', 'mouse', 60, 70)
  const feedback = f.host.querySelector<SVGSVGElement>('.handwriting-eraser-feedback')!
  expect(feedback.style.display).toBe('')
  expect(feedback.querySelector('circle')?.getAttribute('cx')).toBe('60')
  expect(feedback.querySelector('path')?.getAttribute('d')).toBe('M20 30 L60 70')
  f.send('pointerup', 'mouse', 60, 70)
  f.session.exit(); expect(feedback.style.display).toBe('none')
  f.session.dispose(); expect(f.host.querySelector('.handwriting-eraser-feedback')).toBeNull()
})


test('adjacent supporting fingers never reach navigation even when the pen never touches', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 150, 2)
  vi.advanceTimersByTime(50); f.send('pointermove', 'touch', 100, 140, 2)
  f.send('pointerdown', 'touch', 125, 155, 3)
  expect(f.touch('touchstart', [[100, 140], [125, 155]])).toBe(false)
  vi.advanceTimersByTime(1000)
  f.send('pointermove', 'touch', 80, 100, 2); f.send('pointermove', 'touch', 220, 100, 3)
  expect(f.touch('touchmove', [[80, 100], [220, 100]])).toBe(false)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  expect(f.commits).toHaveLength(0)
  f.session.dispose()
})

test('hover rejects a single support touch without requiring pen-down or adding ink', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerover', 'pen', 200, 20)
  f.send('pointerdown', 'touch', 20, 150, 2)
  expect(f.touch('touchstart', [[20, 150]])).toBe(false)
  vi.advanceTimersByTime(1000)
  f.send('pointermove', 'touch', 20, 100, 2)
  expect(f.touch('touchmove', [[20, 100]])).toBe(false)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled(); expect(f.commits).toHaveLength(0)
  f.session.dispose()
})

test('an incipient support drag yields to hover before the navigation deadline', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 20, 150, 2)
  vi.advanceTimersByTime(60); f.send('pointermove', 'touch', 20, 100, 2)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.send('pointermove', 'pen', 200, 40)
  vi.advanceTimersByTime(1000)
  f.send('pointermove', 'touch', 20, 50, 2)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled(); expect(f.commits).toHaveLength(0)
  f.session.dispose()
})

test('close palm contacts yield to pen and remain blocked through pen-up and extra contacts', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 20, 150, 2); f.send('pointerdown', 'touch', 45, 155, 3)
  f.touch('touchstart', [[20, 150], [45, 155]])
  f.send('pointerdown', 'pen', 200, 20); f.send('pointerup', 'pen', 230, 30)
  expect(f.commits).toHaveLength(1)
  vi.advanceTimersByTime(1000)
  f.send('pointerdown', 'touch', 80, 100, 4)
  f.send('pointerup', 'touch', 20, 150, 2); f.send('pointerup', 'touch', 45, 155, 3)
  f.send('pointermove', 'touch', 80, 20, 4)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.send('pointerup', 'touch', 80, 20, 4); f.touch('touchend', [])
  f.send('pointerdown', 'touch', 10, 100, 5); vi.advanceTimersByTime(120); f.send('pointermove', 'touch', 10, 60, 5)
  expect(f.viewport.getMetrics().scrollTop).toBe(240)
  f.session.dispose()
})

test('pointer cancellation cannot revive quarantined Touch Events before the whole group leaves', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 100, 2); f.send('pointerdown', 'touch', 125, 105, 3)
  expect(f.touch('touchstart', [[100, 100], [125, 105]])).toBe(false)
  f.send('pointercancel', 'touch', 100, 100, 2); f.send('pointercancel', 'touch', 125, 105, 3)
  vi.advanceTimersByTime(1000)
  expect(f.touch('touchmove', [[80, 100], [320, 100]])).toBe(false)
  expect(f.touch('touchend', [])).toBe(true)
  f.send('pointerdown', 'touch', 100, 100, 5); f.send('pointerdown', 'touch', 300, 100, 6)
  expect(f.touch('touchstart', [[100, 100], [300, 100]])).toBe(true)
  expect(f.touch('touchmove', [[80, 100], [320, 100]])).toBe(true)
  f.session.dispose()
})

test('pen replaces an unfinished finger-writing draft while a real pinch keeps its native ownership', () => {
  const f = fixture(); f.session.setAllowTouch(true)
  f.send('pointerdown', 'touch', 20, 150, 2); f.send('pointermove', 'touch', 20, 100, 2)
  f.send('pointerdown', 'pen', 200, 20); f.send('pointerup', 'pen', 220, 25)
  expect(f.commits).toHaveLength(1)
  expect(f.commits[0].inkList[0].points[0]).toEqual({ x: 200, y: 20 })
  f.session.dispose()
  const g = fixture()
  g.send('pointerdown', 'touch', 100, 100, 2); g.send('pointerdown', 'touch', 300, 100, 3)
  expect(g.touch('touchstart', [[100, 100], [300, 100]])).toBe(true)
  g.send('pointerdown', 'pen', 200, 20); g.send('pointerup', 'pen', 220, 25)
  expect(g.commits).toHaveLength(0)
  g.send('pointerup', 'touch', 100, 100, 2); g.send('pointerup', 'touch', 300, 100, 3); g.touch('touchend', [])
  g.send('pointerdown', 'pen', 200, 20); g.send('pointerup', 'pen', 220, 25)
  expect(g.commits).toHaveLength(1)
  g.session.dispose()
})

test('pen-up guards a later support touch and exit cancels buffered panning', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'pen', 200, 20); f.send('pointerup', 'pen', 220, 25)
  vi.advanceTimersByTime(400)
  f.send('pointerdown', 'touch', 20, 150, 2)
  vi.advanceTimersByTime(1000); f.send('pointermove', 'touch', 20, 100, 2)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.session.dispose()
  const g = fixture()
  g.send('pointerdown', 'touch', 20, 150, 2); g.send('pointermove', 'touch', 20, 100, 2)
  g.session.dispose(); vi.advanceTimersByTime(1000)
  expect(g.viewport.scrollTo).not.toHaveBeenCalled()
})


test('a quick deliberate swipe finishes within the intent window without getting discarded', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 20, 150, 2)
  vi.advanceTimersByTime(40); f.send('pointermove', 'touch', 20, 110, 2)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.send('pointerup', 'touch', 20, 100, 2)
  expect(f.viewport.getMetrics().scrollTop).toBe(250)
  vi.advanceTimersByTime(1000)
  expect(f.viewport.scrollTo).toHaveBeenCalledTimes(1)
  f.session.dispose()
})

test('a broad support contact is rejected without pen events and stays rejected as its shape shrinks', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 60, height: 28 })
  f.touch('touchstart', [[100, 200]])
  vi.advanceTimersByTime(1000)
  f.send('pointermove', 'touch', 100, 100, 2, 0, { width: 16, height: 14 })
  expect(f.touch('touchmove', [[100, 100]])).toBe(false)
  f.send('pointerup', 'touch', 100, 100, 2); f.touch('touchend', [])
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 16, height: 14 })
  vi.advanceTimersByTime(120); f.send('pointermove', 'touch', 100, 160, 2)
  expect(f.viewport.getMetrics().scrollTop).toBe(240)
  expect(f.commits).toHaveLength(0)
  f.session.dispose()
})

test('a long narrow knuckle contact is rejected even with a small contact area', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 36, height: 8 })
  vi.advanceTimersByTime(200)
  f.send('pointermove', 'touch', 100, 100, 2); f.send('pointerup', 'touch', 100, 100, 2)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  expect(f.commits).toHaveLength(0)
  f.session.dispose()
})

test('Safari ellipse axes reject an oblique support contact despite round pointer bounds', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 26, height: 26 })
  expect(f.touch('touchstart', [[100, 200, 20, 4, 45]])).toBe(false)
  vi.advanceTimersByTime(200)
  f.send('pointermove', 'touch', 100, 100, 2)
  expect(f.touch('touchmove', [[100, 100, 8, 7, 0]])).toBe(false)
  f.send('pointerup', 'touch', 100, 100, 2); f.touch('touchend', [])
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.session.dispose()
})

test('persistent borderline geometry is confirmed within the pan intent window', () => {
  vi.useFakeTimers()
  const f = fixture(), shape = { width: 38, height: 24 }
  f.send('pointerdown', 'touch', 100, 200, 2, 0, shape)
  f.touch('touchstart', [[100, 200, 19, 12]])
  vi.advanceTimersByTime(50)
  f.send('pointermove', 'touch', 100, 180, 2, 0, shape)
  expect(f.touch('touchmove', [[100, 180, 19, 12]])).toBe(false)
  vi.advanceTimersByTime(200)
  f.send('pointerup', 'touch', 100, 100, 2); f.touch('touchend', [])
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.session.dispose()
})

test('new suspicious evidence holds a pending pan and confirmed support cancels its timer', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2)
  vi.advanceTimersByTime(80)
  f.send('pointermove', 'touch', 100, 170, 2, 0, { width: 38, height: 24 })
  vi.advanceTimersByTime(30)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  vi.advanceTimersByTime(20)
  f.send('pointermove', 'touch', 100, 150, 2, 0, { width: 38, height: 24 })
  vi.advanceTimersByTime(1000)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.session.dispose()
})

test('a transient borderline shape returns to normal finger navigation', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 38, height: 24 })
  vi.advanceTimersByTime(20)
  f.send('pointermove', 'touch', 100, 190, 2, 0, { width: 18, height: 16 })
  vi.advanceTimersByTime(100)
  f.send('pointermove', 'touch', 100, 150, 2, 0, { width: 18, height: 16 })
  expect(f.viewport.getMetrics().scrollTop).toBe(250)
  f.session.dispose()
})

test('unavailable geometry preserves normal finger pan and native pinch', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 1, height: 1 })
  expect(f.touch('touchstart', [[100, 200, 0, 0]])).toBe(true)
  vi.advanceTimersByTime(120)
  f.send('pointermove', 'touch', 100, 150, 2, 0, { width: NaN, height: Infinity })
  expect(f.viewport.getMetrics().scrollTop).toBe(250)
  f.send('pointerup', 'touch', 100, 150, 2); f.touch('touchend', [])
  f.send('pointerdown', 'touch', 100, 200, 3)
  f.send('pointerdown', 'touch', 300, 200, 4)
  expect(f.touch('touchstart', [[100, 200], [300, 200]])).toBe(true)
  expect(f.touch('touchmove', [[80, 200], [320, 200]])).toBe(true)
  f.session.dispose()
})

test('one elongated support blocks an otherwise widely separated pair before native pinch starts', () => {
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2)
  f.send('pointerdown', 'touch', 350, 200, 3)
  expect(f.touch('touchstart', [[100, 200, 8, 7], [350, 200, 20, 4]])).toBe(false)
  expect(f.touch('touchmove', [[80, 200, 8, 7], [400, 200, 8, 7]])).toBe(false)
  expect(f.viewport.scrollTo).not.toHaveBeenCalled()
  f.session.dispose()
})

test('geometry changes cannot interrupt an already admitted real pinch', () => {
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 18, height: 16 })
  f.send('pointerdown', 'touch', 300, 200, 3, 0, { width: 18, height: 16 })
  expect(f.touch('touchstart', [[100, 200, 9, 8], [300, 200, 9, 8]])).toBe(true)
  f.send('pointermove', 'touch', 80, 200, 2, 0, { width: 60, height: 40 })
  expect(f.touch('touchmove', [[80, 200, 30, 20], [320, 200, 9, 8]])).toBe(true)
  expect(f.touch('touchend', [])).toBe(true)
  f.send('pointerdown', 'pen', 200, 20); f.send('pointerup', 'pen', 220, 25)
  expect(f.commits).toHaveLength(1)
  f.session.dispose()
})

test('finger-writing remains usable while a broad support cancels the unfinished touch draft', () => {
  const f = fixture(); f.session.setAllowTouch(true)
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 18, height: 16 })
  f.send('pointerup', 'touch', 120, 210, 2)
  expect(f.commits).toHaveLength(1)
  f.send('pointerdown', 'touch', 100, 200, 3, 0, { width: 18, height: 16 })
  f.send('pointermove', 'touch', 120, 210, 3, 0, { width: 60, height: 40 })
  f.send('pointerup', 'touch', 140, 220, 3)
  expect(f.commits).toHaveLength(1)
  expect(f.error).not.toHaveBeenCalled()
  f.session.dispose()
})

test('missing shape samples cannot turn old borderline evidence into a confirmed palm', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.send('pointerdown', 'touch', 100, 200, 2, 0, { width: 38, height: 24 })
  vi.advanceTimersByTime(300)
  f.send('pointermove', 'touch', 100, 180, 2, 0, { width: 38, height: 24 })
  f.send('pointermove', 'touch', 100, 160, 2, 0, { width: 20, height: 18 })
  expect(f.viewport.getMetrics().scrollTop).toBe(240)
  f.session.dispose()
})
