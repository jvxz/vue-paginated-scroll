# vue-paginated-scroll — Design

A headless Vue 3 composable for bidirectional paginated scrolling — the Discord/Slack/Matrix-timeline
message-list pattern. Scroll near an edge → load more → render a bounded window → trim the far edge →
keep scroll position perfectly stable. Matrix is the demanding first customer, but **nothing
Matrix-specific leaks into the API** — it's a general engine for any paginated data.

Terminology is defined in [CONTEXT.md](./CONTEXT.md). Hard decisions are in [docs/adr/](./docs/adr).

---

## 1. Core model: `source` → `window`

Two refs, cleanly separated:

- **`source`** — the full backing array. The **consumer owns and mutates it**, but _only_ from inside
  their own fetch code (`onBeforePaginate`). The library **never writes to it**.
- **`window`** — a derived, bounded ref the composable **returns**. A contiguous slice over `source`;
  this is what the template renders. "Trimming" is not deletion — it narrows the window's boundaries.

The consumer renders `window`, never `source`. Rendering `source` directly would defeat the purpose
(it'd mount everything).

## 2. Windowing, not virtualization ([ADR-0001](./docs/adr/0001-bounded-dom-windowing-not-virtualization.md))

Every item in the window is **real, mounted DOM**. No height estimation, no spacers, no recycling —
because item heights are wildly unpredictable (a one-line "hi" vs. a giant rules message) and can't be
known without mounting. The window stays bounded by a **target height**; the _source_ behind it can be
unbounded. Trade-off: the window caps at hundreds–low-thousands of mounted rows, and heavy rows × tall
window = real mount cost — which is precisely what the perf warning surfaces (§9).

## 3. Sizing — everything in viewport-multiples

The container's height is watched reactively (`ResizeObserver`/`useElementSize`) so everything adapts to
resize and across devices. Knobs, all expressed as multiples of viewport height:

- **`targetHeight`** (~3×) — the height the window tries to stay near.
- **`buffer`** (~0.3×) — runway kept on the _opposite_ side of scroll after a trim. Two jobs: keep the
  trimmed edge away from its trigger (loop safety), and give reaction runway on direction reversal.
- **`triggerDistance`** (~0.5×) — how close to an edge fires a pagination.

**Height is primary, clamped by one count ceiling and one trim invariant:**

- **`maxItems`** (~250, tunable) — a hard ceiling on mounted rows. Protects against the _tiny-items,
  tall-target_ pathology (e.g. ~140 one-liners to fill a 4200px target × heavier config = hundreds of
  nodes), which pixel-based governance can't catch. When hit, the window stops _below_ `targetHeight` —
  node safety wins.
- **Trim invariant: never trim an item intersecting viewport + buffer.** This is a dynamic, pixel-derived
  floor that handles the _one-giant-item_ pathology (a single message taller than the whole target) —
  it guarantees the item the user is reading is never trimmed and that runway always exists, _without_ a
  static `minItems` knob (deliberately omitted — it'd be a worse version of this invariant). If `maxItems`
  is set so low it can't cover viewport + buffer, that's a misconfiguration surfaced via `debug`.

## 4. Pagination lifecycle (backward / scroll-up shown)

1. **Trigger fires** — user scrolled within `triggerDistance` of the top edge.
2. **Measure anchor** — record the position of a visible, least-likely-to-reflow item element.
3. **`await onBeforePaginate('backward')`** — the consumer fetches a page and prepends to `source`.
4. **Recompute window** — pure, idempotent function of current state (source + keys + anchor + geometry):
   grow the top toward `targetHeight`, trim the bottom back down.
5. **Restore anchor** — set `scrollTop` so the anchor element is visually exactly where it was.
   Runs post-flush, before paint — no visible intermediate frame.

The recompute is **declarative and idempotent**: the library never diffs `source` to learn _what_
changed, only recomputes from current state. Running it twice is harmless.

## 5. Loop prevention — defense in depth ([ADR-0002](./docs/adr/0002-layered-loop-prevention.md))

The defining failure mode is the **pagination loop** (a trim re-arms the opposite trigger → infinite
paginate). Prevented by three cooperating layers so no single failure breaks it:

1. **Geometric coupling** — default `buffer` = `triggerDistance` + margin, so naive config is loop-safe.
2. **Re-arm latching** — a fired trigger is disarmed until the user leaves its zone and returns.
3. **Direction gating** — only the trigger matching current scroll direction is armed.

The trigger itself is **pure scroll-position math** (a continuous distance-to-edge scalar), not a DOM
sentinel — latching/gating are far easier to reason about against a scalar than binary visibility events.

## 6. Scroll preservation ([ADR-0003](./docs/adr/0003-anchor-element-primary-overflow-anchor-supplemental.md))

- **Anchor-element compensation is the universal primary.** Pin a visible landmark element across the
  grow+trim; correctness is independent of how much was added/removed. Works identically on every browser.
- **`overflow-anchor` is supplemental only.** It's unsupported on all Safari through v26 (~79% global,
  the missing ~21% is WebKit/iOS — a primary chat target), so it can't anchor our paginations. It earns
  its keep only for _incidental_ reflows _between_ paginations (a late image loading above the fold).
- During the anchor restore, the library asserts `overflow-anchor: none` so the browser can't
  double-correct and fight the manual `scrollTop` set.

## 7. Identity & DOM access

- **`getKey(item) => string | number`** (required) — stable identity, used for edge tracking, window
  computation, and anchor survival across trims. Never array position (positions shift on prepend).
- **`v-pgs-item` directive** on each rendered row — the library's one reach into consumer markup. It
  stamps identity and registers the element (`key → element`) so the anchor logic can locate nodes,
  surviving date dividers and other non-item children that positional mapping would break on. DOM
  tampering by the end-user voids the stability warranty by design — not the library's problem.

## 8. Exhaustion — developer-declared, never inferred

**`hasMore(direction) => MaybeRefOrGetter<boolean>`**. The library resolves it via `toValue` inside its
reactive scope. Exhaustion is **never** inferred from the array (which grows before pagination logic runs
and says nothing about history behind a token/gap) — only the consumer's data source truly knows. While a
direction reads `false` its trigger is disarmed; if it flips back (gap backfilled, live edge advanced) the
trigger re-arms. Omitted → `() => true`.

## 9. Live behaviors — feature-rich but opt-in ([ADR-0004](./docs/adr/0004-source-watching-and-mid-window-mutations.md))

The core is a pure pagination/windowing engine; live behaviors are layered features nobody pays for
unless enabled. To support them the library **watches `source`** to know _that_ it changed (recompute
now) — but still never diffs deltas.

- **`followTail`** (opt-in) — when new items arrive _and_ the user is at the live edge, re-pin to bottom;
  if they've scrolled up, arriving items must never yank them down.
- **`isAtLiveEdge`** (reactive) — drives a jump-to-latest pill.
- **`scrollToEdge(direction)`** — programmatic jump (may paginate forward to reach the live edge).

Two dispatch paths, deliberately different:

- _Pagination_ is **bracketed** (needs a "before" measurement, §4).
- _Unsolicited growth/mutation_ is **watch-driven** (source changed → recompute → apply follow policy).

**Mid-window mutations** (edits, redactions, optimistic echoes): core does **recompute only** (a redaction
drops the item; an edit re-renders) — no deterministic height-anchoring, those get `overflow-anchor` for
free where supported. Deterministic mid-window height-anchoring is a **later opt-in** via a single shared
`ResizeObserver` piggybacked on `v-pgs-item`. Overhead isn't the gate (a shared RO over ~150 rows is
sub-frame — it fires only on actual resize, batched before paint); the gate is scope/correctness.

## 10. Dev experience

- **Render-latency warning** — times only the **render clock** (recompute → rows painted), _excluding_
  the fetch (consumer owns fetching, library owns rendering). Over `slowPaginationMs` (~50ms default) it
  emits an actionable `console.warn`: direction, elapsed vs threshold, items mounted, height added, and
  **per-item average** so you know whether to lower `targetHeight` (too many) or lighten the row (too
  heavy). Gated behind `debug`; tree-shakes out of production.
- **Debug overlay** — the composable exposes structured `debugState` (trigger bands, per-direction
  armed/disarmed flags, anchor, live-edge, latencies) **and** the library ships an optional
  `<PaginatedScrollDebug>` component that renders it out of the box (colored trigger bands tinted by arm
  state, buffer shading, anchor outline, live-edge marker, latency HUD). Headless core stays pure; obvious
  visual is one import away; vanishes from prod builds. Answers "when" (arm-state colors / fire pulse) and
  "where" (band positions).

## 11. Bootstrap

Seed + fill-to-target: the consumer seeds `source`; the library sets the initial window to `initialEdge`
(`'forward'` default = live edge / bottom, chat archetype; `'backward'` for feeds), scrolls there, then
**auto-paginates until viewport + buffer is filled or exhausted**. The fill pass is a necessity, not a
nicety: if the first page is shorter than the viewport there's nothing to scroll, so no trigger could ever
fire and the list would be permanently stuck under-filled. The same fill pass also protects against any
pagination that came up short.

---

## Proposed composable API (sketch — names still open)

```ts
const {
  window,          // Ref<T[]>        — render THIS (v-for), each row gets v-pgs-item
  isAtLiveEdge,    // Ref<boolean>    — drive a jump-to-latest pill
  isPaginating,    // per-direction reactive state
  scrollToEdge,    // (direction) => Promise<void>
  debugState,      // feed to <PaginatedScrollDebug>
} = usePaginatedScroll(containerRef, {
  source,                              // Ref<T[]> — consumer-owned, mutated only in onBeforePaginate
  getKey: (item) => item.event_id,     // required identity
  hasMore: (dir) => /* SDK state */,   // MaybeRefOrGetter<boolean>, default () => true
  onBeforePaginate: async (dir) => {   // consumer fetches + mutates source; library awaits
    const page = await sdk.paginate(dir)
    source.value = dir === 'backward' ? [...page, ...source.value] : [...source.value, ...page]
  },

  targetHeight: 3,        // viewport multiples
  buffer: 0.3,            // viewport multiples
  triggerDistance: 0.5,   // viewport multiples
  initialEdge: 'forward',

  followTail: true,       // opt-in live-tail
  debug: false,           // dev overlay + latency warnings
  slowPaginationMs: 50,
})
```

`containerRef` is the template ref you bind to the scroll container; `v-pgs-item` goes on each rendered row.

## Dependencies

VueUse is the one hard dependency (`useElementSize`, `useScroll`, `toValue`, `MaybeRefOrGetter`, event
listeners). Otherwise minimal — `ResizeObserver` and scroll math are used directly. No virtualization
library, no `IntersectionObserver` abstraction.

---

## Open questions (not yet decided)

1. **Exact default values** for `targetHeight` / `buffer` / `triggerDistance` / `maxItems` /
   `slowPaginationMs` — need empirical tuning against a real room.
2. **`isPaginating` shape** — single boolean, per-direction, or a richer status enum.
3. **Naming pass** on all public options/returns before first release.

_(Resolved: item-count governance — `maxItems` ceiling + a "never trim viewport+buffer" invariant;
no `minItems`. See §3.)_
