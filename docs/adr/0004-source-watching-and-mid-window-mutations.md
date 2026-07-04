# Library watches source for idempotent recompute; mid-window height-anchoring is opt-in

**Context.** Enabling `followTail` (and handling edits/redactions/optimistic echoes) means the library must react to the source changing when it didn't trigger the change. This partially revisits an earlier stance that the library had no reason to observe the source. It also raises how much the library owns for _mid-window_ mutations (an edit above the fold shifting content, a redaction removing a windowed item).

**Decision.**

- The library **watches the source ref** to know _that_ it changed and recompute — but **never diffs to learn _what_ changed**. The window is a pure, **idempotent** function of current state (source + keys + anchor + geometry). If a mutation is handled by both the pagination bracket and the source watch, running the recompute twice is harmless.
- **Two paths, deliberately different:**
  - _Pagination_ is **bracketed**: measure anchor → `await onBeforePaginate` → recompute → restore anchor (needs the "before" measurement, so it cannot be a passive watch).
  - _Unsolicited growth / mutation_ is **watch-driven**: source changes → recompute → apply follow policy.
- **Mid-window mutations, core behavior = recompute only (option A).** A redaction drops the item from the window; an edit re-renders. The library does **not** deterministically preserve scroll for mid-window height changes in the core — those get `overflow-anchor` for free where supported, nothing on Safari.
- **Deterministic mid-window height-anchoring is opt-in (option B, later).** Implemented via a **single shared `ResizeObserver`** piggybacked on the `v-pgs-item` directive (observe on register, unobserve on unregister).

**Consequences.**

- Overhead is **not** the reason it's opt-in. A shared RO over ~100–200 windowed rows is sub-frame: it fires only on actual resize (batched, before paint), so observed-count is nearly free and cost tracks resize events, which are rare. The opt-in gate is about _scope/correctness_ (which resize means "re-anchor" vs "ignore"), not cost.
- The RO callback adjusts `scrollTop`, not element size, so it cannot trigger the "ResizeObserver loop" error; an `rAF` defer is available if ever needed.
