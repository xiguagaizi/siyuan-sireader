import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

// Home Screen WebKit can omit requestFullscreen entirely. Page expansion keeps
// the existing native viewer mounted and does not trigger system fullscreen UI.
export function useReaderDisplay(root: Ref<HTMLElement | null>, onError: (error: unknown) => void) {
  const expanded = ref(false), nativeActive = ref(false), nativeAvailable = ref(false)
  const safeAreaStyle = ref<Record<string, string>>({})
  const fullscreen = computed(() => expanded.value || nativeActive.value)
  const standalone = window.matchMedia('(display-mode: standalone)')
  const isStandalone = () => standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  let probe: HTMLElement | null = null, observer: ResizeObserver | null = null, frame = 0
  let popoverOwner: HTMLElement | null = null, previousFocus: HTMLElement | null = null
  const measure = () => {
    frame = 0
    const element = root.value
    nativeAvailable.value = !!element && typeof element.requestFullscreen === 'function' && document.fullscreenEnabled !== false && !isStandalone()
    nativeActive.value = !!element && document.fullscreenElement === element
    if (!element || !probe) return
    const viewport = window.visualViewport
    const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight
    const box = element.getBoundingClientRect(), safe = getComputedStyle(probe)
    const px = (value: string) => parseFloat(value) || 0
    // Only inset the part that actually overlaps the screen safe area. A reader
    // below SiYuan's header already has room, so it must not get a second gap.
    const style = {
      '--reader-safe-top': `${Math.max(0, top + px(safe.paddingTop) - box.top)}px`,
      '--reader-safe-left': `${Math.max(0, left + px(safe.paddingLeft) - box.left)}px`,
      '--reader-safe-right': `${Math.max(0, box.right - left - width + px(safe.paddingRight))}px`,
      '--reader-safe-bottom': `${Math.max(0, box.bottom - top - height + px(safe.paddingBottom))}px`,
      '--reader-viewport-top': `${top}px`, '--reader-viewport-left': `${left}px`,
      '--reader-viewport-width': `${width}px`, '--reader-viewport-height': `${height}px`,
    }
    if (JSON.stringify(style) !== JSON.stringify(safeAreaStyle.value)) safeAreaStyle.value = style
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
  const closeExpanded = () => {
    if (popoverOwner) {
      const element = popoverOwner; popoverOwner = null
      if (element.matches(':popover-open')) element.hidePopover()
      element.removeAttribute('popover')
    }
    expanded.value = false
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    previousFocus = null
    schedule()
  }
  const restore = async () => {
    closeExpanded()
    if (root.value && document.fullscreenElement === root.value && typeof document.exitFullscreen === 'function') {
      try { await document.exitFullscreen() } catch (error) { onError(error) }
    }
    measure()
  }
  const expand = async () => {
    const element = root.value
    if (!element) return
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    expanded.value = true
    await nextTick()
    // The top layer escapes clipping/stacking contexts in docked SiYuan panes,
    // without reparenting the custom PDF element (which would destroy it).
    if (typeof element.showPopover === 'function' && !element.hasAttribute('popover')) {
      element.setAttribute('popover', 'manual')
      try { element.showPopover(); popoverOwner = element }
      catch { element.removeAttribute('popover') }
    }
    measure()
  }
  const toggle = async () => {
    measure()
    if (fullscreen.value) { await restore(); return }
    if (nativeAvailable.value && root.value) {
      try { await root.value.requestFullscreen(); measure(); return }
      catch { /* A denied API also falls back to page expansion. */ }
    }
    await expand()
  }
  const onKey = (event: KeyboardEvent) => { if (expanded.value && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeExpanded() } }
  watch(root, element => { observer?.disconnect(); if (element) observer?.observe(element); schedule() }, { flush: 'post' })
  onMounted(() => {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
    document.body.append(probe)
    observer = new ResizeObserver(schedule)
    if (root.value) observer.observe(root.value)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    standalone.addEventListener('change', schedule)
    document.addEventListener('fullscreenchange', schedule)
    document.addEventListener('keydown', onKey)
    measure()
  })
  onBeforeUnmount(() => {
    closeExpanded(); cancelAnimationFrame(frame); observer?.disconnect(); probe?.remove()
    window.removeEventListener('resize', schedule)
    window.removeEventListener('orientationchange', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('scroll', schedule)
    standalone.removeEventListener('change', schedule)
    document.removeEventListener('fullscreenchange', schedule)
    document.removeEventListener('keydown', onKey)
  })
  return { expanded, fullscreen, nativeAvailable, safeAreaStyle, toggle, restore }
}
