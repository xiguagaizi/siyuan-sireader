// The snippet's public tool factories own sampling, preview and PDF coordinates.
// Keep raw input here: EmbedPDF 2.x strips pointerType/pressure when dispatching.
import { createPalmRejection } from './palmRejection'

export const TOUCH_INTENT_DELAY = 100, PEN_TOUCH_GUARD = 650, MIN_PINCH_SPAN = 80
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
  let pan: { x: number; y: number; left: number; top: number; readyAt: number } | null = null
  let panTimer: ReturnType<typeof setTimeout> | undefined
  let nativePinch = false, palmGesture = false, touchCount = 0
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
  const palmRejection = createPalmRejection()
  const pointerTypes = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover'] as const
  const safe = (fn: () => void) => { try { fn() } catch (error) { onError(error) } }
  const stop = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopImmediatePropagation() }
  const stopPan = () => { clearTimeout(panTimer); panTimer = undefined; pan = null }
  const flushPan = () => {
    clearTimeout(panTimer); panTimer = undefined
    if (!enabled || allowTouch || penDown || blocked.size || (palmGesture && touchCount > 0) || Date.now() < palmUntil || touches.size !== 1 || multiTouch || !pan) return
    const pending = palmRejection.pendingDelay(Date.now())
    if (pending) { panTimer = setTimeout(flushPan, pending); return }
    const point = touches.values().next().value!
    if (Math.hypot(point.x - pan.x, point.y - pan.y) < 10) return
    viewport.scrollTo({ x: pan.left + pan.x - point.x, y: pan.top + pan.y - point.y, behavior: 'instant' })
  }
  const quarantineTouches = () => {
    if (!penDown && capturedId !== null) safe(() => finishCurrent?.(false))
    if (touches.size || touchCount) palmGesture = true
    for (const id of touches.keys()) blocked.add(id)
    touches.clear(); stopPan(); multiTouch = false
  }
  const claimPen = () => {
    // A genuine pinch already admitted to EmbedPDF must finish in its own
    // coordinates. Reject likely palms BEFORE starting that native gesture.
    if (nativePinch) return
    quarantineTouches()
    palmUntil = Date.now() + PEN_TOUCH_GUARD
  }
  const onPointer = (event: PointerEvent) => {
    raw = event
    if (!enabled) return
    if (event.pointerType === 'pen' && ['pointerover', 'pointermove', 'pointerdown'].includes(event.type)) claimPen()
    if (tool === 'eraser' && (event.pointerType !== 'touch' || allowTouch)) {
      showFeedback(event)
      if (event.type === 'pointerup' || event.type === 'pointercancel') trailTimer = setTimeout(hideFeedback, 180)
    }
    if (event.pointerType === 'touch') {
      if (!nativePinch && (event.type === 'pointerdown' || event.type === 'pointermove') &&
        palmRejection.observe(`pointer:${event.pointerId}`, event, Date.now())) {
        quarantineTouches(); blocked.add(event.pointerId); palmGesture = true
      }
      if (event.type === 'pointerdown' && (penDown || Date.now() < palmUntil || blocked.size > 0 || (palmGesture && touchCount > 0))) blocked.add(event.pointerId)
      if (blocked.has(event.pointerId)) {
        if (event.type === 'pointerup' || event.type === 'pointercancel') {
          blocked.delete(event.pointerId); palmRejection.release(`pointer:${event.pointerId}`)
          if (!blocked.size && !touchCount) { palmGesture = false; palmRejection.reset() }
        }
        stop(event); return
      }
      if (event.type === 'pointerdown') {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (touches.size === 1) {
          const m = viewport.getMetrics()
          pan = { x: event.clientX, y: event.clientY, left: m.scrollLeft, top: m.scrollTop, readyAt: Date.now() + TOUCH_INTENT_DELAY }
          clearTimeout(panTimer); panTimer = setTimeout(flushPan, TOUCH_INTENT_DELAY)
        } else {
          multiTouch = true; stopPan()
          const [a, b] = Array.from(touches.values())
          if (!nativePinch && (touches.size > 2 || Math.hypot(a.x - b.x, a.y - b.y) < MIN_PINCH_SPAN)) {
            quarantineTouches(); stop(event); return
          }
        }
      }
      if (event.type === 'pointermove' && touches.has(event.pointerId)) {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (!allowTouch && touches.size === 1 && !penDown && !multiTouch && pan) {
          if (Date.now() >= pan.readyAt) flushPan()
          if (event.cancelable) event.preventDefault()
        }
      }
      if (event.type === 'pointerup' || event.type === 'pointercancel') {
        // A quick, substantial single-finger swipe can finish inside the short
        // intent window. Commit its final displacement instead of dropping it.
        if (event.type === 'pointerup' && touches.size === 1 && !multiTouch && pan &&
          (Date.now() >= pan.readyAt || Math.hypot(event.clientX - pan.x, event.clientY - pan.y) >= 30)) {
          touches.set(event.pointerId, { x: event.clientX, y: event.clientY }); flushPan()
        }
        touches.delete(event.pointerId)
        palmRejection.release(`pointer:${event.pointerId}`)
        if (!touches.size) { stopPan(); multiTouch = false }
      }
    }
  }
  // Classify the touch group before native pinch sees touchstart. Cancelling
  // only after its preview begins can shift ink or commit a spurious zoom.
  const onTouch = (event: TouchEvent) => {
    if (!enabled) return
    touchCount = event.touches.length
    if (event.type === 'touchend' || event.type === 'touchcancel') {
      if (touchCount < 2) nativePinch = false
      for (const touch of Array.from(event.changedTouches || [])) palmRejection.release(`touch:${touch.identifier}`)
      if (!touchCount) { palmGesture = false; blocked.clear(); touches.clear(); stopPan(); multiTouch = false; palmRejection.reset() }
      return // Let genuine native gestures complete their normal cleanup.
    }
    // Touch identifiers are not Pointer IDs. Keep independent evidence for
    // the ellipse axes Safari exposes even when pointer geometry is absent.
    // Never preempt an admitted native pinch's temporary page transform.
    if (!nativePinch) {
      let rejected = false
      for (const touch of Array.from(event.touches)) {
        if (palmRejection.observe(`touch:${touch.identifier}`, { width: touch.radiusX * 2, height: touch.radiusY * 2 }, Date.now())) rejected = true
      }
      if (rejected) { quarantineTouches(); palmGesture = true }
    }
    if (penDown || Date.now() < palmUntil || blocked.size || palmGesture) { palmGesture = true; stop(event); return }
    if (event.type === 'touchstart' && touchCount === 2) {
      const [a, b] = Array.from(event.touches)
      if (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) < MIN_PINCH_SPAN) {
        quarantineTouches(); palmGesture = true; stop(event); return
      }
      nativePinch = true
    }
    if (!allowTouch && touchCount === 1 && event.type === 'touchmove') stop(event)
    if (!nativePinch && touchCount > 2) { quarantineTouches(); palmGesture = true; stop(event) }
  }
  const acceptDown = (event: PointerEvent | null) => {
    if (!enabled || !event) return false
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size > 1) { finishCurrent?.(false); return false }
      return allowTouch && !penDown && !blocked.has(event.pointerId)
    }
    if (event.pointerType === 'pen') {
      if (nativePinch) return false
      claimPen()
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
        if (penDown) { penDown = false; palmUntil = Date.now() + PEN_TOUCH_GUARD }
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
      hideFeedback(); stopPan(); multiTouch = false; nativePinch = palmGesture = false; touchCount = 0
      undoGroups.length = redoGroups.length = 0; notifyHistory()
      enabled = false; penDown = false; touches.clear(); blocked.clear(); palmUntil = 0; palmRejection.reset()
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
    setAllowTouch(value: boolean) { safe(() => finishCurrent?.(true)); allowTouch = value; touches.clear(); stopPan(); multiTouch = false; palmRejection.reset() },
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
