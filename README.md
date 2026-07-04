# vue-paginated-scroll

A **headless** Vue 3 composable for stable, bidirectional paginated scrolling — the
Discord / Slack / Matrix-timeline message-list pattern. Scroll near an edge → load more →
render a bounded window of real DOM → trim the far edge → keep the scroll position perfectly
stable. No virtualization, one hard dependency (VueUse), and a rich dev overlay.

> Matrix is the first customer, but nothing Matrix-specific leaks in — it's a general engine
> for any paginated data. See [`DESIGN.md`](./DESIGN.md) and [`docs/adr/`](./docs/adr) for the
> reasoning behind every decision, and [`CONTEXT.md`](./CONTEXT.md) for the vocabulary.

## Install

```bash
pnpm add vue-paginated-scroll @vueuse/core
```

## Usage

```vue
<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { usePaginatedScroll, PaginatedScrollDebug } from 'vue-paginated-scroll'

const container = ref<HTMLElement | null>(null)

// You own and mutate this array — only inside onBeforePaginate. shallowRef, not
// ref: the library only ever reads `.length`, iterates for keys, and slices —
// it never depends on an individual item's own reactivity. See "Performance" below.
const events = shallowRef<MatrixEvent[]>(await loadInitialPage())

const { window, vItem, isAtLiveEdge, scrollToEdge, debugState } = usePaginatedScroll(container, {
  source: events,
  getKey: (e) => e.event_id,

  // Fetch a page and mutate `events`. The library awaits, then re-derives the window.
  onBeforePaginate: async (direction) => {
    const page = await sdk.paginate(direction)
    events.value =
      direction === 'backward' ? [...page, ...events.value] : [...events.value, ...page]
  },

  // Developer-declared exhaustion — never inferred from the array.
  hasMore: (direction) =>
    direction === 'backward' ? timeline.canBackfill : !timeline.atLiveEdge,

  targetHeight: 3, // viewport multiples
  buffer: 0.3,
  triggerDistance: 0.5,
  maxItems: 250,
  initialEdge: 'forward', // open at the bottom (chat); use 'backward' for feeds
  followTail: true, // stick to bottom on new messages iff already at the bottom
  debug: import.meta.env.DEV,
})
</script>

<template>
  <div ref="container" class="timeline" style="position: relative; overflow-y: auto">
    <!-- Render `window`, NOT your source array. Each row gets v-pgs-item. -->
    <MessageRow v-for="event in window" :key="event.event_id" v-item="event.event_id" :event="event" />

    <PaginatedScrollDebug :state="debugState" />
  </div>

  <button v-if="!isAtLiveEdge" @click="scrollToEdge('forward')">Jump to latest ↓</button>
</template>
```

Register the directive globally as `v-item` **or** bind the returned `vItem` locally
(`v-pgs-item` in your own registration). The one rule: it must sit on every rendered row so the
library can locate item elements for scroll anchoring.

## API

`usePaginatedScroll(containerRef, options)` — see [`src/types.ts`](./src/types.ts) for the full
typed surface. Key options: `source`, `getKey` (required), `onBeforePaginate` (required),
`hasMore`, `targetHeight`, `buffer`, `triggerDistance`, `maxItems`, `initialEdge`, `followTail`,
`debug`, `slowPaginationMs`.

Returns: `window` (render this), `isAtLiveEdge`, `isPaginating`, `vItem`, `scrollToEdge`,
`debugState`.

## Why it's built this way (the short version)

- **Bounded real DOM, not virtualization** — chat message heights are unknowable without
  mounting, so no estimation. The window is capped; the source can be unbounded. ([ADR-0001](./docs/adr/0001-bounded-dom-windowing-not-virtualization.md))
- **No accidental pagination** — three cooperating layers (geometric coupling, re-arm latching,
  direction gating) over a scroll-distance scalar. ([ADR-0002](./docs/adr/0002-layered-loop-prevention.md))
- **Rock-stable scroll** — anchor-element compensation as the universal primary (works on Safari,
  where `overflow-anchor` doesn't); native scroll-anchoring is supplemental only. ([ADR-0003](./docs/adr/0003-anchor-element-primary-overflow-anchor-supplemental.md))
- **Declarative core** — the library watches the source to know *that* it changed and re-derives
  the window idempotently; it never diffs deltas. ([ADR-0004](./docs/adr/0004-source-watching-and-mid-window-mutations.md))

## License

MIT
