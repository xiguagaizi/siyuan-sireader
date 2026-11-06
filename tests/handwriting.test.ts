// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest'
import { createHandwritingSession, createHandwritingTools, HANDWRITING_TOOLS, hitsHandwriting, segmentsDistance } from '../src/handwriting/session'

const ink = (id = 'hand') => ({ type: 15, id, pageIndex: 0, strokeWidth: 2, custom: { sireaderHandwriting: 1 }, inkList: [{ points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] }] })
function fixture() {
  const host = document.createElement('div'), tools = new Map<string, any>(), objects: any[] = [], commits: any[] = []
  let selected: any = { id: 'old-tool' }, lock: any = { type: 'none' }, mode = 'panMode'
  const scope = {
    getActiveTool: () => selected, setActiveTool: vi.fn((id: string) => { selected = id && (tools.get(id) || { id }); mode = id ? 'annotation:' + id : 'panMode' }),
    getLocked: () => lock, setLocked: (next: any) => { lock = next }, deselectAnnotation: vi.fn(),
    getAnnotations: () => objects.map(object => ({ object })), deleteAnnotations: vi.fn((items: any[]) => items.forEach(item => objects.splice(objects.findIndex(a => a.id === item.id), 1))),
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
  const caps: any = { annotation: root, viewport: { forDocument: () => viewport }, 'interaction-manager': { forDocument: () => interaction } }
  const error = vi.fn()
  let session: ReturnType<typeof createHandwritingSession>
  createHandwritingTools(() => session).forEach(tool => root.addTool(tool))
  session = createHandwritingSession({ registry: { getPlugin: (id: string) => ({ provides: () => caps[id] }) }, documentId: 'test', host, onError: error })
  let handler: any
  const choose = (kind: 'pen' | 'eraser' | 'highlighter') => {
    session.setTool(kind)
    handler = tools.get(HANDWRITING_TOOLS[kind]).pointerHandler.create({ getTool: () => selected, pageIndex: 0, scale: 1, pageSize: { width: 600, height: 800 }, onPreview: vi.fn(), onCommit: (a: any) => { commits.push(a); objects.push(a) } })
  }
  const send = (type: string, pointerType: string, x: number, y: number, pointerId = 1, button = 0) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as any
    Object.assign(event, { pointerType, pointerId, clientX: x, clientY: y, button })
    const allowed = host.dispatchEvent(event)
    if (allowed) handler[({ pointerdown: 'onPointerDown', pointermove: 'onPointerMove', pointerup: 'onPointerUp', pointercancel: 'onPointerCancel' } as any)[type]]?.({ x, y }, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() }, '')
  }
  session.enter(); choose('pen')
  return { host, session, scope, tools, commits, objects, choose, send, viewport, error, mode: () => mode, lock: () => lock }
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
  const f = fixture()
  f.send('pointerdown', 'touch', 10, 100, 2); f.send('pointermove', 'touch', 10, 60, 2)
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
