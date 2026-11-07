// The snippet's public tool factories own sampling, preview and PDF coordinates.
// Keep raw input here: EmbedPDF 2.x strips pointerType/pressure when dispatching.
export type HandwritingTool = 'pen' | 'highlighter' | 'eraser'
type Point = { x: number; y: number }
export const HANDWRITING_TOOLS = { pen: 'sireader-handwriting-pen', highlighter: 'sireader-handwriting-highlighter', eraser: 'sireader-handwriting-eraser' }
// Register before pages mount: v2's paint layer only registers tools at mount
// and scale changes. Late addTool() would leave existing pages unable to draw.
export const createHandwritingTools = (getSession: () => ReturnType<typeof createHandwritingSession> | null, onPageReady = () => {}) => (['pen', 'highlighter', 'eraser'] as const).map(kind => ({
  id: HANDWRITING_TOOLS[kind], name: `SiReader handwriting ${kind}`, categories: ['annotation', 'markup'], matchScore: () => 0,
  interaction: { exclusive: true, cursor: kind === 'eraser' ? 'none' : 'crosshair' },
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

// randomUUID is restricted to secure contexts; SiYuan also supports LAN HTTP.
const strokeId = () => globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')

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
  registry: any; documentId: string; host: HTMLElement; onError: (error: unknown) => void; onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void
}) {
  const { registry, documentId, host, onError } = options
  const capability = (id: string) => registry.getPlugin(id)?.provides()
  const root = capability('annotation'), scope = root?.forDocument(documentId)
  const viewport = capability('viewport')?.forDocument(documentId)
  const interaction = capability('interaction-manager')?.forDocument(documentId)
  const history = capability('history')?.forDocument(documentId)
  if (!root?.getTool || !scope || !viewport || !interaction) throw new Error('Handwriting requires the EmbedPDF annotation, interaction and viewport plugins')
  const getTool = (id: string) => root.getTool?.(id) || root.getTools().find((t: any) => t.id === id)
  const pen = getTool('ink'), highlighter = getTool('inkHighlighter')
  if (!pen?.pointerHandler?.create) throw new Error('The installed PDF runtime does not expose an ink tool factory')
  let enabled = false, disposed = false, tool: HandwritingTool = 'pen', allowTouch = false
  let capturedId: number | null = null
  let raw: PointerEvent | null = null, penDown = false, palmUntil = 0
  let previous: { tool: any; mode: string; locked: any } | null = null
  let finishCurrent: ((commit: boolean) => void) | null = null
  let pan: { x: number; y: number; left: number; top: number } | null = null
  let multiTouch = false, replaying = false, recording = false, groupCount = 0
  const undoGroups: number[] = [], redoGroups: number[] = []
  const notifyHistory = () => options.onHistoryChange?.({ canUndo: undoGroups.length > 0, canRedo: redoGroups.length > 0 })
  const offHistory = history?.onHistoryChange((topic: string) => {
    if (replaying) return
    if (recording && topic === 'annotations') { groupCount++; return }
    // Any external edit or native keyboard undo invalidates our gesture boundary.
    undoGroups.length = redoGroups.length = 0; notifyHistory()
  })
  const record = (fn: () => void) => { recording = true; try { fn() } finally { recording = false } }
  const closeGroup = () => { if (groupCount) { undoGroups.push(groupCount); redoGroups.length = 0; groupCount = 0; notifyHistory() } }
  const ns = 'http://www.w3.org/2000/svg'
  const feedback = document.createElementNS(ns, 'svg'), ring = document.createElementNS(ns, 'circle'), trail = document.createElementNS(ns, 'path')
  feedback.setAttribute('aria-hidden', 'true'); feedback.setAttribute('class', 'handwriting-eraser-feedback')
  feedback.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:10;display:none'
  ring.setAttribute('r', '10'); ring.setAttribute('fill', 'rgba(255,255,255,.6)'); ring.setAttribute('stroke', '#526477'); ring.setAttribute('stroke-width', '1.5')
  trail.setAttribute('fill', 'none'); trail.setAttribute('stroke', 'rgba(95,119,148,.25)'); trail.setAttribute('stroke-width', '20'); trail.setAttribute('stroke-linecap', 'round'); trail.setAttribute('stroke-linejoin', 'round')
  feedback.append(trail, ring); host.append(feedback)
  let trailPoints: Point[] = [], trailTimer: ReturnType<typeof setTimeout> | undefined
  const hideFeedback = () => { feedback.style.display = 'none'; trailPoints = []; trail.setAttribute('d', ''); clearTimeout(trailTimer) }
  const showFeedback = (event: PointerEvent) => {
    const box = host.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top
    feedback.style.display = ''; ring.setAttribute('cx', String(x)); ring.setAttribute('cy', String(y))
    if (capturedId === event.pointerId) {
      clearTimeout(trailTimer); trailPoints.push({ x, y }); trailPoints = trailPoints.slice(-24)
      trail.setAttribute('d', trailPoints.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' '))
    }
  }
  const touches = new Map<number, Point>(), blocked = new Set<number>()
  const pointerTypes = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const
  const safe = (fn: () => void) => { try { fn() } catch (error) { onError(error) } }
  const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation() }
  const onPointer = (event: PointerEvent) => {
    raw = event
    if (!enabled) return
    if (tool === 'eraser' && (event.pointerType !== 'touch' || allowTouch)) {
      showFeedback(event)
      if (event.type === 'pointerup' || event.type === 'pointercancel') trailTimer = setTimeout(hideFeedback, 180)
    }
    if (event.pointerType === 'touch') {
      if (event.type === 'pointerdown' && (penDown || Date.now() < palmUntil)) blocked.add(event.pointerId)
      if (blocked.has(event.pointerId)) {
        if (event.type === 'pointerup' || event.type === 'pointercancel') blocked.delete(event.pointerId)
        stop(event); return
      }
      if (event.type === 'pointerdown') {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (touches.size === 1) { const m = viewport.getMetrics(); pan = { x: event.clientX, y: event.clientY, left: m.scrollLeft, top: m.scrollTop } }
        else { multiTouch = true; pan = null }
      }
      if (event.type === 'pointermove' && touches.has(event.pointerId) && !allowTouch && touches.size === 1 && !penDown && !multiTouch && pan) {
        // Same absolute origin as native panMode; no stale-metric accumulation.
        viewport.scrollTo({ x: pan.left + pan.x - event.clientX, y: pan.top + pan.y - event.clientY, behavior: 'instant' })
        if (event.cancelable) event.preventDefault()
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        touches.delete(event.pointerId)
        if (!touches.size) { pan = null; multiTouch = false }
      }
    }
  }
  // Native pinch uses Touch Events. Suppress its start/moves during pen contact,
  // but let end/cancel reach it so an earlier gesture cannot remain stuck.
  const onTouch = (event: TouchEvent) => {
    if (enabled && !allowTouch && touches.size === 1 && event.type === 'touchmove') { stop(event); return }
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
        if (erase) { closeGroup(); return }
        if (!commit || !data) return
        // Commit at pen-up, synchronously. The native handler's 800ms grouping
        // timer is deliberately bypassed, including on mode exit/unmount.
        const inkList = data.inkList.map((s: any) => ({ points: s.points.length === 1 ? [s.points[0], { x: s.points[0].x + .01, y: s.points[0].y }] : s.points }))
        record(() => context.onCommit({ ...data, inkList, type: 15, id: strokeId(), pageIndex: context.pageIndex, created: new Date(), custom: { ...data.custom, sireaderHandwriting: 1 } }))
        closeGroup()
      }
      const eraseAt = (point: Point) => {
        const radius = 10 / Math.max(.05, context.scale || 1)
        const matches = scope.getAnnotations().map((a: any) => a.object).filter((a: any) => a.pageIndex === context.pageIndex && hitsHandwriting(a, lastPoint || point, point, radius))
        if (matches.length) record(() => scope.deleteAnnotations(matches.map((a: any) => ({ pageIndex: a.pageIndex, id: a.id }))))
        lastPoint = point
      }
      return {
        onPointerDown(pos: Point, event: any, mode: string) {
          if (!acceptDown(raw) || activeId !== null) return
          finishCurrent?.(true)
          activeId = raw!.pointerId; capturedId = activeId; penDown = raw!.pointerType === 'pen'; lastPoint = pos; lastEvent = event; finishCurrent = finish
          safe(() => { if (erase) { trailPoints = []; showFeedback(raw!); event.setPointerCapture?.(); eraseAt(pos) } else native.onPointerDown(pos, event, mode) })
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
  host.addEventListener('pointerleave', hideFeedback)
  const offTool = scope.onActiveToolChange?.((value: any) => {
    if (enabled && value?.id !== HANDWRITING_TOOLS[tool]) queueMicrotask(() => { if (enabled && !disposed && scope.getActiveTool()?.id !== HANDWRITING_TOOLS[tool]) activate() })
  })
  return {
    createHandler(kind: HandwritingTool, context: any) { return factory(kind === 'highlighter' ? highlighter || pen : pen, kind === 'eraser').create(context) },
    enter() {
      if (enabled || disposed) return
      previous = { tool: scope.getActiveTool(), mode: interaction.getActiveMode(), locked: scope.getLocked() }
      undoGroups.length = redoGroups.length = 0; notifyHistory()
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
      hideFeedback(); pan = null; multiTouch = false
      undoGroups.length = redoGroups.length = 0; notifyHistory()
      enabled = false; penDown = false; touches.clear(); blocked.clear(); palmUntil = 0
      scope.deselectAnnotation()
      if (previous) { scope.setLocked(previous.locked); scope.setActiveTool(previous.tool?.id || null); interaction.activate(previous.mode) }
      previous = null
    },
    undo() {
      this.finish()
      const count = undoGroups.pop(); if (!count || !history) return
      replaying = true
      try { for (let i = 0; i < count; i++) history.undo(); redoGroups.push(count) }
      finally { replaying = false; notifyHistory() }
    },
    redo() {
      this.finish()
      const count = redoGroups.pop(); if (!count || !history) return
      replaying = true
      try { for (let i = 0; i < count; i++) history.redo(); undoGroups.push(count) }
      finally { replaying = false; notifyHistory() }
    },
    setTool(next: HandwritingTool) { safe(() => finishCurrent?.(true)); hideFeedback(); tool = next; if (enabled) activate() },
    setAllowTouch(value: boolean) { safe(() => finishCurrent?.(true)); allowTouch = value; touches.clear(); pan = null; multiTouch = false },
    setStyle(color: string, width: number) {
      safe(() => finishCurrent?.(true))
      for (const kind of ['pen', 'highlighter'] as const) root.setToolDefaults(HANDWRITING_TOOLS[kind], { strokeColor: color, color, strokeWidth: kind === 'pen' ? width : width * 5 })
    },
    dispose() {
      this.exit(); disposed = true; offTool?.(); offHistory?.(); hideFeedback(); feedback.remove()
      host.removeEventListener('pointerleave', hideFeedback)
      host.removeEventListener('lostpointercapture', onLostCapture, true)
      pointerTypes.forEach(type => host.removeEventListener(type, onPointer, true))
      ;['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(type => host.removeEventListener(type, onTouch, true))
    },
  }
}
