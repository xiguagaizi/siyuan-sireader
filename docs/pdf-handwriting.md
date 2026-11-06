# Independent PDF handwriting mode (MVP)

The PDF toolbar has a **手写笔记 / Handwriting** entry. It opens a separate touch-sized toolbar with Pen, Highlighter, whole-stroke Eraser, color, width, Finger writing and Exit. Every entry starts with Pen. Pen-up keeps the tool active without selecting the new ink or opening its editor. The original toolbar returns on exit.

This is phase 1 plus a basic highlighter. Pressure-dependent widths, smoothing, dedicated undo/redo, partial erasing, pen side-button shortcuts and an additional handwriting export workflow remain later work. Existing native PDF export operates on the same standard annotations; it is not a newly implemented export feature.

## Reuse and boundaries

- `src/handwriting/session.ts` supplies independent tool IDs, raw input routing, lifecycle and a whole-stroke hit test. `HandwritingToolbar.vue` owns the mode's controls; `EmbedPdfReader.vue` only connects them to the current document.
- Tools are registered through the snippet's `annotations.tools` configuration before page mounting. The entry also waits until the native page event providers have mounted; file/annotation readiness alone can precede those providers and lose an early first stroke. EmbedPDF 2.15.1's paint-layer effect does not register late-added tools for already mounted pages; relying on `addTool()` at mode entry can silently miss the first strokes.
- Drawing delegates sampling and preview to the actual native `ink.pointerHandler` / `inkHighlighter.pointerHandler`. EmbedPDF's page provider owns scale, intrinsic rotation, viewer rotation and natural page coordinates. There is no second viewer or independent canvas/page renderer.
- EmbedPDF 2.x normalizes pointer events without retaining `pointerType`, `pointerId` or pressure. A listener on this viewer's host captures the original event before native dispatch. Dedicated factories use that event synchronously for filtering; no synthetic events or global pointer handlers are installed.
- Native ink normally groups strokes for 800 ms. This mode commits the native preview at pen-up, then clears its draft through the native cancel method. It does not start the grouping timer. This gives each pen-down/up a separate standard INK annotation and allows synchronous final-stroke capture before teardown. Single-point dots receive a tiny second point.
- Pen and primary-button mouse draw/erase. By default one finger scrolls through `viewport.scrollTo`; native zoom handles the two-finger Touch Events. Finger writing is an explicit per-reader toggle; adding a second finger cancels an unfinished finger stroke before pinch navigation.
- Basic palm protection suppresses touch navigation while the pen is down, retains blocked contacts until they lift and has a short post-pen interval. It coordinates both Pointer Events and the native Touch Events pinch path. It does not claim hardware-level palm rejection or hover prediction.
- Erasing checks the swept eraser segment against the ink's line segments, accounting for line width and zoom. It invokes native batch deletion without selection and only deletes INK annotations marked `custom.sireaderHandwriting = 1`. Existing PDF ink, highlights, comments and normal-mode annotations are preserved.
- Mode exit restores the previous tool, interaction mode and annotation lock. Cancel discards a draft; capture loss and explicit exit/flush finalize visible ink. Source change, text-reflow switch and unmount detach mode listeners. A restricted PDF cannot silently enter a tool that the runtime refused to activate.

## Persistence

Handwriting uses the existing standard `AnnotationTransferItem` geometry and SiReader's normal per-book JSON record. The existing manual annotation commit queue and ID-based upsert/delete queue are unchanged. Entry waits for both annotation loading and the native page-handler effect batch, exit waits for commit and persistence, and unmount captures the last draft before the normal pending-save path runs.

The same record therefore participates in SiYuan's existing file sync. This does not introduce cross-device concurrent-edit merging or guarantee synchronization of two devices editing offline. Pen color/width and the finger toggle currently belong to the open reader instance.

## Validation

Commands from the repository root:

```sh
pnpm install
pnpm test:run
pnpm build
# Install/provide Playwright separately, or set PLAYWRIGHT_MODULE to its entry.
# BROWSER_EXECUTABLE optionally selects an existing Chromium binary.
node scripts/check-pdf-handwriting-browser.mjs
```

- Twelve new unit tests cover sweep hit testing, protection of original annotations, separate immediate strokes, pen retention, touch pan, two-finger takeover, palm contacts, finger-writing opt-in, cancellation, mode restoration, capture loss and mouse-button filtering.
- Browser coverage uses the actual Vue reader, bundled EmbedPDF 2.15.1/PDFium, CDP pen/touch input, mixed PDF page sizes and intrinsic rotation. It covers continuous pen, highlighter width/opacity, finger-writing opt-in, no selected annotation, finger pan without ink, real native pinch zoom, whole-stroke erasing, immediate exit, stored geometry after remount, rotation/zoom/page-coordinate projection, original ink preservation and desktop/tablet/mobile toolbars.
- The browser fixture substitutes the SiYuan host storage boundary with in-memory records. It exercises the reader's commit/persistence bridge and reopen import, not a live SiYuan installation or actual multi-device sync. Existing storage tests exercise the storage layer separately.
- The existing real-browser text-reflow regression also passes: native scrolling/navigation, markup creation, source updates/deletes, repeated mode switches and legacy annotation backfill.
- Production build passes. Full Vitest result: 172 passed, 2 failed out of 174. The failures are the existing `copyMarkdown.test.ts` callback-arity expectation and `licenseFlow.test.ts` usage-report read expectation. Both reproduce on unmodified upstream commit `32d7ce779cf30f1274d3a9429e2d69394c81c241`; no unrelated behavior was changed to silence them.
- Two prerequisite build fixes retain behavior: resolve Foliate's existing short SHA to the identical complete commit, and correct `BookShelf.vue` to the tracked `Bookshelf.vue` import on case-sensitive Linux.

## Android tablet acceptance still required

1. Physical active-pen type/pressure reports, latency, fast small handwriting and dots.
2. Palm before/during/after pen contact, finger/pen alternation and two-finger takeover in the actual SiYuan Android WebView.
3. Long documents, dense ink, memory/heat, app backgrounding and close/reopen with real SiYuan file storage.
4. Two actual synced devices, including deletion propagation; do not assume concurrent offline edits are merged.
5. Installed light/dark/custom themes and system color picker behavior.

Browser CDP input and screenshots do not substitute for these device checks.
