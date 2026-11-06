// The snippet's public tool factories own sampling, preview and PDF coordinates.
// Keep raw input here: EmbedPDF 2.x strips pointerType/pressure when dispatching.
export type HandwritingTool = 'pen' | 'highlighter' | 'eraser'
type Point = { x: number; y: number }
export const HANDWRITING_TOOLS = { pen: 'sireader-handwriting-pen', highlighter: 'sireader-handwriting-highlighter', eraser: 'sireader-handwriting-eraser' }
// Register before pages mount: v2's paint layer only registers tools at mount
// and scale changes. Late addTool() would leave existing pages unable to draw.
export const createHandwritingTools = (getSession: () => ReturnType<typeof createHandwritingSession> | null, onPageReady = () => {}) => (['pen', 'highlighter', 'eraser'] as const).map(kind => ({
  id: HANDWRITING_TOOLS[kind], name: `SiReader handwriting ${kind}`, categories: ['annotation', 'markup'], matchScore: () => 0,
  interaction: { exclusive: true, cursor: kind === 'eraser' ? 'cell' : 'crosshair' },
  defaults: { type: 15, strokeColor: '#243247', color: '#243247', strokeWidth: 2, opacity: kind === 'highlighter' ? .35 : 1 },
  behavior: { deactivateToolAfterCreate: false, selectAfterCreate: false, editAfterCreate: false },
  pointerHandler: { annotationType: 15, create(context: any) {
    // The PDF document can load before its page's DOM event providers mount.
    // Announce readiness after this native effect batch, not at file load.
    queueMicrotask(onPageReady)
    let owner: ReturnType<typeof createHandwritingSession> | null = null, handler: any = null
    const delegate = (key: string, args: any[]) => {
      const current = getSession()
      if (current !== owner) { handler?.onHandlerActiveEnd?.(); owner = current; handler = current?.createHandler(kind, context) }
      return handler?.[key]?.(...args)
    }
    return Object.fromEntries(['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel', 'onHandlerActiveEnd'].map(key => [key, (...args: any[]) => delegate(key, args)]))
  } },
}))

export const isHandwriting = (a: any) => a?.type === 15 && a.custom?.sireaderHandwriting === 1

const pointDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
export const segmentsDistance = (a: Point, b: Point, c: Point, d: Point) => {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b)
  if (abC * abD < 0 && cdA * cdB < 0) return 0
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b))
}
export const hitsHandwriting = (a: any, from: Point, to: Point, radius: number) => {
  if (!isHandwriting(a)) return false
  const tolerance = radius + Math.max(0, Number(a.strokeWidth) || 1) / 2
  return (a.inkList || []).some((stroke: any) => {
    const points: Point[] = stroke.points || []
    return points.some((p, i) => segmentsDistance(from, to, points[Math.max(0, i - 1)], p) <= tolerance)
  })
}

export function createHandwritingSession(options: {
  registry: any; documentId: string; host: HTMLElement; onError: (error: unknown) => void
}) {
  const { registry, documentId, host, onError } = options
  const capability = (id: string) => registry.getPlugin(id)?.provides()
  const root = capability('annotation'), scope = root?.forDocument(documentId)
  const viewport = capability('viewport')?.forDocument(documentId)
  const interaction = capability('interaction-manager')?.forDocument(documentId)
  if (!root?.getTool || !scope || !viewport || !interaction) throw new Error('Handwriting requires the EmbedPDF annotation, interaction and viewport plugins')
  const getTool = (id: string) => root.getTool?.(id) || root.getTools().find((t: any) => t.id === id)
  const pen = getTool('ink'), highlighter = getTool('inkHighlighter')
  if (!pen?.pointerHandler?.create) throw new Error('The installed PDF runtime does not expose an ink tool factory')
  let enabled = false, disposed = false, tool: HandwritingTool = 'pen', allowTouch = false
  let capturedId: number | null = null
  let raw: PointerEvent | null = null, penDown = false, palmUntil = 0
  let previous: { tool: any; mode: string; locked: any } | null = null
  let finishCurrent: ((commit: boolean) => void) | null = null
  const touches = new Map<number, Point>(), blocked = new Set<number>()
  const pointerTypes = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const
  const safe = (fn: () => void) => { try { fn() } catch (error) { onError(error) } }
  const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation() }
  const onPointer = (event: PointerEvent) => {
    raw = event
    if (!enabled) return
    if (event.pointerType === 'touch') {
      if (event.type === 'pointerdown' && (penDown || Date.now() < palmUntil)) blocked.add(event.pointerId)
      if (blocked.has(event.pointerId)) {
        if (event.type === 'pointerup' || event.type === 'pointercancel') blocked.delete(event.pointerId)
        stop(event); return
      }
      const last = touches.get(event.pointerId)
      if (last && event.type === 'pointermove') {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (!allowTouch && touches.size === 1 && !penDown) {
          const metrics = viewport.getMetrics()
          viewport.scrollTo({ x: metrics.scrollLeft + last.x - event.clientX, y: metrics.scrollTop + last.y - event.clientY, behavior: 'instant' })
          if (event.cancelable) event.preventDefault()
        }
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') touches.delete(event.pointerId)
    }
  }
  // Native pinch uses Touch Events. Suppress its start/moves during pen contact,
  // but let end/cancel reach it so an earlier gesture cannot remain stuck.
  const onTouch = (event: TouchEvent) => {
    if (enabled && (penDown || Date.now() < palmUntil || blocked.size) && !['touchend', 'touchcancel'].includes(event.type)) stop(event)
  }
  const acceptDown = (event: PointerEvent | null) => {
    if (!enabled || !event) return false
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size > 1) { finishCurrent?.(false); return false }
      return allowTouch && !penDown && !blocked.has(event.pointerId)
    }
    if (event.pointerType === 'pen') {
      if (touches.size > 1) return false
      for (const id of touches.keys()) blocked.add(id)
      touches.clear()
      return true
    }
    return event.pointerType === 'mouse' && event.button === 0
  }
  const factory = (base: any, erase = false) => ({
    annotationType: 15,
    create(context: any) {
      let activeId: number | null = null, preview: any = null, lastPoint: Point | null = null, lastEvent: any = null
      const native = erase ? null : base.pointerHandler.create({ ...context, onPreview: (value: any) => { preview = value; context.onPreview(value) } })
      const finish = (commit: boolean) => {
        if (activeId === null) return
        const data = preview?.data
        activeId = null; capturedId = null
        if (penDown) { penDown = false; palmUntil = Date.now() + 120 }
        if (finishCurrent === finish) finishCurrent = null
        try { native?.onPointerCancel?.(lastPoint, lastEvent, '') }
        catch (error) { if ((error as DOMException)?.name !== 'NotFoundError') throw error }
        if (erase) lastEvent?.releasePointerCapture?.()
        preview = null
        if (!commit || !data) return
        // Commit at pen-up, synchronously. The native handler's 800ms grouping
        // timer is deliberately bypassed, including on mode exit/unmount.
        const inkList = data.inkList.map((s: any) => ({ points: s.points.length === 1 ? [s.points[0], { x: s.points[0].x + .01, y: s.points[0].y }] : s.points }))
        context.onCommit({ ...data, inkList, type: 15, id: crypto.randomUUID(), pageIndex: context.pageIndex, created: new Date(), custom: { ...data.custom, sireaderHandwriting: 1 } })
      }
      const eraseAt = (point: Point) => {
        const radius = 10 / Math.max(.05, context.scale || 1)
        const matches = scope.getAnnotations().map((a: any) => a.object).filter((a: any) => a.pageIndex === context.pageIndex && hitsHandwriting(a, lastPoint || point, point, radius))
        if (matches.length) scope.deleteAnnotations(matches.map((a: any) => ({ pageIndex: a.pageIndex, id: a.id })))
        lastPoint = point
      }
      return {
        onPointerDown(pos: Point, event: any, mode: string) {
          if (!acceptDown(raw) || activeId !== null) return
          finishCurrent?.(true)
          activeId = raw!.pointerId; capturedId = activeId; penDown = raw!.pointerType === 'pen'; lastPoint = pos; lastEvent = event; finishCurrent = finish
          safe(() => { if (erase) { event.setPointerCapture?.(); eraseAt(pos) } else native.onPointerDown(pos, event, mode) })
        },
        onPointerMove(pos: Point, event: any, mode: string) {
          if (activeId === null || raw?.pointerId !== activeId) return
          lastEvent = event
          safe(() => { if (erase) eraseAt(pos); else { lastPoint = pos; native.onPointerMove(pos, event, mode) } })
        },
        onPointerUp(pos: Point, event: any, mode: string) {
          if (activeId === null || raw?.pointerId !== activeId) return
          lastEvent = event
          safe(() => { if (erase) eraseAt(pos); else { lastPoint = pos; native.onPointerMove(pos, event, mode) }; finish(true) })
        },
        onPointerCancel() { if (raw?.pointerId === activeId) safe(() => finish(false)) },
        onHandlerActiveEnd() { safe(() => finish(true)) },
      }
    },
  })
  for (const [kind, base] of [['pen', pen], ['highlighter', highlighter || pen]] as const) {
    root.setToolDefaults(HANDWRITING_TOOLS[kind], { ...base.defaults, opacity: kind === 'highlighter' ? .35 : 1, custom: { sireaderHandwriting: 1 } })
  }
  pointerTypes.forEach(type => host.addEventListener(type, onPointer, { capture: true, passive: false }))
  ;['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(type => host.addEventListener(type, onTouch, { capture: true, passive: false }))
  const activate = () => { scope.deselectAnnotation(); scope.setActiveTool(HANDWRITING_TOOLS[tool]) }
  const onLostCapture = (event: PointerEvent) => { if (enabled && capturedId === event.pointerId) safe(() => finishCurrent?.(true)) }
  host.addEventListener('lostpointercapture', onLostCapture, true)
  const offTool = scope.onActiveToolChange?.((value: any) => {
    if (enabled && value?.id !== HANDWRITING_TOOLS[tool]) queueMicrotask(() => { if (enabled && !disposed && scope.getActiveTool()?.id !== HANDWRITING_TOOLS[tool]) activate() })
  })
  return {
    createHandler(kind: HandwritingTool, context: any) { return factory(kind === 'highlighter' ? highlighter || pen : pen, kind === 'eraser').create(context) },
    enter() {
      if (enabled || disposed) return
      previous = { tool: scope.getActiveTool(), mode: interaction.getActiveMode(), locked: scope.getLocked() }
      enabled = true; tool = 'pen'; scope.setLocked({ type: 'all' }); activate()
      if (scope.getActiveTool()?.id !== HANDWRITING_TOOLS.pen) {
        this.exit()
        throw new Error('This PDF does not allow annotation changes')
      }
    },
    finish() { safe(() => finishCurrent?.(true)) },
    exit() {
      if (!enabled) return
      safe(() => finishCurrent?.(true))
      enabled = false; penDown = false; touches.clear(); blocked.clear(); palmUntil = 0
      scope.deselectAnnotation()
      if (previous) { scope.setLocked(previous.locked); scope.setActiveTool(previous.tool?.id || null); interaction.activate(previous.mode) }
      previous = null
    },
    setTool(next: HandwritingTool) { safe(() => finishCurrent?.(true)); tool = next; if (enabled) activate() },
    setAllowTouch(value: boolean) { safe(() => finishCurrent?.(true)); allowTouch = value; touches.clear() },
    setStyle(color: string, width: number) {
      safe(() => finishCurrent?.(true))
      for (const kind of ['pen', 'highlighter'] as const) root.setToolDefaults(HANDWRITING_TOOLS[kind], { strokeColor: color, color, strokeWidth: kind === 'pen' ? width : width * 5 })
    },
    dispose() {
      this.exit(); disposed = true; offTool?.()
      host.removeEventListener('lostpointercapture', onLostCapture, true)
      pointerTypes.forEach(type => host.removeEventListener(type, onPointer, true))
      ;['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(type => host.removeEventListener(type, onTouch, true))
    },
  }
}
