// Independent web implementation inspired by:
// iptsd: src/contacts/validation/validator.hpp (size/aspect, tracked validity)
// https://github.com/linux-surface/iptsd/blob/9c7a55462f2bcf3268689e314dfcaaef884e16e6/src/contacts/validation/validator.hpp
// Chromium: neural_stylus_palm_detection_filter.cc (hold before admission,
// successive samples). No upstream code, trained model or device thresholds
// are copied: evdev/sensor millimeters cannot be used as browser CSS pixels.
// https://github.com/chromium/chromium/blob/091de37af62da9f9d901a9d2e5f10b109752731f/ui/events/ozone/evdev/touch_filter/neural_stylus_palm_detection_filter.cc

type ContactSize = { width?: number; height?: number }
type Evidence = { since: number; samples: number; lastAt: number; rejected: boolean }
const CONFIRM_MS = 40, HOLD_MS = 80, MAX_SAMPLE_GAP_MS = 120

export function createPalmRejection() {
  const contacts = new Map<string, Evidence>()
  return {
    observe(id: string, size: ContactSize, now: number): boolean {
      const previous = contacts.get(id)
      if (previous?.rejected) return true
      const { width, height } = size
      // Missing, zero and the Pointer Events default 1x1 contain no usable
      // shape information. Never interpret absent data as a large contact.
      if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) return false
      const major = Math.max(width, height), minor = Math.min(width, height), aspect = major / minor
      // These conservative CSS-pixel thresholds need actual device testing.
      // Pointer width/height bound the contact, so their aspect is only a
      // lower bound for an oblique ellipse. Touch radiusX/Y supply its axes.
      const strong = (major >= 54 && minor >= 10) || minor >= 36 || (major >= 32 && aspect >= 2.8)
      const suspicious = strong || (major >= 36 && minor >= 22) || (major >= 24 && aspect >= 2.3)
      if (!suspicious) { contacts.delete(id); return false }
      const evidence = previous && now - previous.lastAt <= MAX_SAMPLE_GAP_MS
        ? previous : { since: now, samples: 0, lastAt: -Infinity, rejected: false }
      if (now > evidence.lastAt) { evidence.samples++; evidence.lastAt = now }
      evidence.rejected = strong || (evidence.samples >= 2 && now - evidence.since >= CONFIRM_MS)
      contacts.set(id, evidence)
      return evidence.rejected
    },
    pendingDelay(now: number) {
      let delay = 0
      for (const contact of contacts.values()) if (!contact.rejected) delay = Math.max(delay, contact.since + HOLD_MS - now)
      return Math.max(0, delay)
    },
    release(id: string) { contacts.delete(id) },
    reset() { contacts.clear() },
  }
}
