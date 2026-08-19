# Anchor-element compensation is the primary scroll-preservation mechanism; overflow-anchor is supplemental only

**Context.** When the window grows on one edge and trims on the other in a single pagination, both operations change `scrollHeight` and the viewport will lurch unless corrected within one frame. Candidate mechanisms: (A) `scrollHeight` delta math, (B) pinning a visible anchor element, (C) native CSS `overflow-anchor`, (D) `column-reverse` layout.

Native `overflow-anchor` (C) is tempting as a zero-code primary, but it is **unsupported on all Safari through v26** (macOS and iOS), only appearing in the Safari 27 beta as of mid-2026 — ~79% global support, with the missing ~21% being almost entirely WebKit/iOS, i.e. a primary target for a chat scroller. It is also spec-suppressed at scroll offset 0. So it cannot be the mechanism that anchors our paginations; on iOS it would silently never run and every backward pagination would lurch.

**Decision.**

- **(B) Anchor-element compensation is the universal, deterministic primary.** Before consumer pagination code runs, the library records a fully-visible item and its offset. Scroll-coordinate movement while the fetch awaits updates the intended offset without measuring after consumer DOM has changed. After each DOM flush it restores the item. Correctness is independent of how much was added/removed and behaves identically across browsers.
- **Registered-row reflows are deterministic**, handled by one shared `ResizeObserver` that compensates height changes above the active anchor or preserves the live-edge bottom pin.
- **(C) `overflow-anchor` is supplemental only** for unregistered consumer DOM reflows. It is never depended upon.
- During B's correction window the library asserts **`overflow-anchor: none`** so the browser cannot also correct and fight B's manual `scrollTop` set (the classic double-correction jump); auto is relied on only for the incidental case.
- (D) `column-reverse` rejected: it fights upward-pagination anchoring, complicates selection/accessibility, and dictates layout to a headless library.

**Consequences.**

- The library must be able to identify and locate individual item elements inside the container — the one place this otherwise hands-off library reaches into consumer markup.
- Residual risk: if the anchor element _itself_ contains late-loading media it can still drift; the anchor-selection rule should prefer the visible element least likely to reflow.
