# vue-paginated-scroll

A headless Vue composable for implementing bidirectional paginated scrolling (the Discord/Slack/Matrix-timeline message-list pattern): loading older/newer items as the user scrolls near the edges, and trimming the opposite edge to keep the DOM light and the scrollbar usable.

## Language

**Trigger**:
The per-direction condition that fires a pagination: the user has scrolled within `triggerDistance` (a viewport-multiple) of an edge. Implemented as **pure scroll-position math** over `scrollTop`/`scrollHeight`/`clientHeight` — deliberately _not_ a DOM sentinel element or `IntersectionObserver`, because loop-prevention (re-arm latching, direction gating) is far easier to reason about against a continuous distance-to-edge scalar than against binary visibility events. A trigger can be _armed_ or _disarmed_ (by direction gating, re-arm latching, or exhaustion).
_Avoid_: sentinel (rejected — implies a DOM marker element, which this is not), IntersectionObserver, hitbox.

**Live edge**:
The forward-most boundary of the source — the newest item. "At the live edge" means the window's forward boundary is the newest item _and_ the user is scrolled to the bottom, so newly-arriving items should append into view. Exposed reactively (e.g. `isAtLiveEdge`) so the consumer can drive a jump-to-latest affordance.
_Avoid_: bottom (ambiguous with scroll position), tail (use only in "follow tail"), head.

**Follow tail**:
An opt-in behavior (`followTail`) where the library auto-pins the view to the live edge when new items arrive _iff_ the user is already at the live edge. If the user has scrolled up into history, arriving items must never yank them down. Part of the "feature-rich but opt-in" posture: the core is a pure pagination/windowing engine; live behaviors like this are layered features nobody pays for unless enabled.
_Avoid_: autoscroll, stick to bottom (informal), tailing.

**Direction**:
The axis of a pagination. **Backward** = toward older items = scrolling up (loads at the top edge). **Forward** = toward newer items = scrolling down (loads at the bottom edge). Every trigger, buffer, and exhaustion signal is per-direction.
_Avoid_: up/down (ambiguous once layout changes), older/newer (use as clarifiers, not the primary term), previous/next.

**Exhaustion**:
The developer-declared, per-direction signal that no more items can ever be loaded in that direction (start of history reached, or at the live edge). Expressed as `hasMore(direction) => MaybeRefOrGetter<boolean>`. It is **never inferred** by the library from the source array — the array grows before pagination logic runs and its contents say nothing about whether more history exists behind a token/gap; only the consumer's data source truly knows. While a direction is exhausted its trigger is disarmed; if the signal flips back (gap backfilled, live edge advanced) the trigger re-arms.
_Avoid_: hasMore (that's the option name, not the concept), end of history, done, depleted.

**Edge item**:
The first or last item currently present in the source (see below), tracked by identity. The library uses edge items to reason about window boundaries relative to the source.
_Avoid_: sentinel (that term is reserved for the DOM trigger concept), boundary item, anchor item.

**Source**:
The full backing array the consumer owns, passes into the composable, and mutates — but _only_ from inside their own pagination-fetch code (e.g. an `onBeforePaginate` hook). The library never writes to the source, in fetch or trim. It is not what the UI renders directly.
_Avoid_: raw data, backing store, dataset.

**Render latency**:
The time from window recompute to the newly-paginated rows being mounted and painted — the "render clock." Deliberately **excludes** the fetch (`onBeforePaginate`): the consumer owns fetching, the library owns rendering, so the warning only measures what the library is responsible for orchestrating. When it exceeds `slowPaginationMs` the library emits an actionable `console.warn` (direction, elapsed vs threshold, items mounted, height added, per-item average) so the developer can tell whether the cost is "too many items" (lower `targetHeight`) or "heavy rows" (lighter component). The render clock is jointly owned — library controls count/timing, consumer controls per-row cost — and the per-item average disambiguates which.
_Avoid_: fetch latency (explicitly not measured), mount time, lag.

**Anchor element**:
A real, currently-visible item element the library pins during a pagination so it stays visually fixed while the window grows on one edge and trims on the other. The library records its position before the DOM mutation and restores it after, making scroll preservation immune to how much was added or removed. Chosen as the least-likely-to-reflow visible element. This is the universal, deterministic scroll-preservation mechanism, working identically across all browsers.
_Avoid_: scroll token, pivot, reference node.

**Buffer**:
The runway of rendered-but-not-visible content the library deliberately keeps on the _opposite_ side of the scroll direction after a trim. Expressed as a viewport-multiple. Serves two jobs: (1) it stops the just-trimmed edge from sitting right at the trigger point (which would re-fire pagination — see **Pagination loop**), and (2) it gives the user reaction runway if they reverse scroll direction before the next trigger should fire.
_Avoid_: breathing room (informal), overscan (that term implies virtualization, which this is not), padding, margin.

**Pagination loop**:
The core stability failure mode: a trim brings the opposite edge close enough to its trigger that pagination immediately re-fires, which trims again, and so on. Preventing this is a primary invariant of the library. Chiefly avoided by keeping the buffer strictly larger than the trigger distance and by re-arm latching (a trigger cannot fire again until the user has left its zone).
_Avoid_: feedback loop, thrash.

**Window**:
The derived, bounded ref the composable returns. A contiguous slice over the source that the UI actually renders. "Trimming" is not deletion — it is narrowing the window's boundaries, a pure computation over the source. The window never exceeds the source.
_Avoid_: paginated data, view, page, viewport (viewport means the visible scroll area, not the rendered slice).
