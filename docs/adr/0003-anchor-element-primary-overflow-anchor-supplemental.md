# Anchor-element compensation is the primary scroll-preservation mechanism; overflow-anchor is supplemental only

**Context.** When the window grows on one edge and trims on the other in a single pagination, both operations change `scrollHeight` and the viewport will lurch unless corrected within one frame. Candidate mechanisms: (A) `scrollHeight` delta math, (B) pinning a visible anchor element, (C) native CSS `overflow-anchor`, (D) `column-reverse` layout.

Native `overflow-anchor` (C) is tempting as a zero-code primary, but it is **unsupported on all Safari through v26** (macOS and iOS), only appearing in the Safari 27 beta as of mid-2026 — ~79% global support, with the missing ~21% being almost entirely WebKit/iOS, i.e. a primary target for a chat scroller. It is also spec-suppressed at scroll offset 0. So it cannot be the mechanism that anchors our paginations; on iOS it would silently never run and every backward pagination would lurch.

**Decision.**

- **(B) Anchor-element compensation is the universal, deterministic primary.** Before the mutation the library records the position of a chosen visible item element; after the DOM flush (post-flush tick, before paint) it restores that element's position. Correctness is independent of how much was added/removed — it pins a landmark rather than doing delta arithmetic (rejecting A, which is fragile to async reflow). It behaves identically across all browsers.
- **(C) `overflow-anchor` is supplemental only**, earning its keep for _incidental_ reflows _between_ paginations (e.g. a late-loading image/embed above the viewport) which B structurally cannot cover because B only runs on pagination events. It is a bonus on the ~79% that support it, never depended upon.
- During B's correction window the library asserts **`overflow-anchor: none`** so the browser cannot also correct and fight B's manual `scrollTop` set (the classic double-correction jump); auto is relied on only for the incidental case.
- (D) `column-reverse` rejected: it fights upward-pagination anchoring, complicates selection/accessibility, and dictates layout to a headless library.

**Consequences.**

- The library must be able to identify and locate individual item elements inside the container — the one place this otherwise hands-off library reaches into consumer markup.
- Residual risk: if the anchor element _itself_ contains late-loading media it can still drift; the anchor-selection rule should prefer the visible element least likely to reflow.
