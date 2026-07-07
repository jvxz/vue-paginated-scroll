import type { Ref } from 'vue'

import { useElementSize, useEventListener } from '@vueuse/core'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, toValue, watch } from 'vue'

import type { ScrollGeometry } from './geometry'
import type { Direction, ItemKey, PaginatedScroll, PaginatedScrollOptions, DebugState } from './types'

import { distanceToEdge, isSafeToTrim, isScrolledToForwardEnd, resolveTrigger } from './geometry'
import { ItemRegistry, createItemDirective } from './registry'

const DIRECTIONS: Direction[] = ['backward', 'forward']
const OPPOSITE: Record<Direction, Direction> = { backward: 'forward', forward: 'backward' }

interface AnchorSnapshot {
  key: ItemKey
  /** Distance from the viewport top to the item's top, at capture time. */
  viewportOffset: number
}

interface ItemBox {
  key: ItemKey
  top: number
  bottom: number
}

/**
 * Bounded-window infinite scroll over a source array you own and mutate.
 *
 * @param container The scrollable element.
 * @param options See {@link PaginatedScrollOptions}.
 */
export function usePaginatedScroll<T>(
  container: Ref<HTMLElement | null | undefined>,
  options: PaginatedScrollOptions<T>,
): PaginatedScroll<T> {
  const { getKey, onBeforePaginate } = options
  const initialEdge = options.initialEdge ?? 'forward'

  // Resolved via toValue on each read so options stay reactive.
  const cfg = {
    buffer: () => toValue(options.buffer) ?? 0.3,
    debug: () => toValue(options.debug) ?? false,
    followTail: () => toValue(options.followTail) ?? false,
    maxItems: () => toValue(options.maxItems) ?? 250,
    slowPaginationMs: () => toValue(options.slowPaginationMs) ?? 50,
    targetHeight: () => toValue(options.targetHeight) ?? 3,
    triggerDistance: () => toValue(options.triggerDistance) ?? 0.5,
  }

  const hasMoreFor = (d: Direction): boolean => (options.hasMore ? toValue(options.hasMore(d)) : true)

  const sourceItems = computed<readonly T[]>(() => toValue(options.source) ?? [])

  const keyToIndex = computed(() => {
    const m = new Map<ItemKey, number>()
    const items = sourceItems.value
    for (let i = 0; i < items.length; i++) m.set(getKey(items[i]!), i)
    return m
  })

  // Boundaries are stored as keys, not indices — indices shift on every prepend.
  const startKey = ref<ItemKey | null>(null)
  const endKey = ref<ItemKey | null>(null)

  function boundIndices(): { s: number; e: number } | null {
    const items = sourceItems.value
    if (items.length === 0) return null
    const k2i = keyToIndex.value
    let s = startKey.value != null ? k2i.get(startKey.value) : undefined
    let e = endKey.value != null ? k2i.get(endKey.value) : undefined
    if (s === undefined) s = 0
    if (e === undefined) e = items.length - 1
    if (s > e) [s, e] = [e, s]
    return { e, s }
  }

  const window = computed<T[]>(() => {
    const b = boundIndices()
    if (!b) return []
    return sourceItems.value.slice(b.s, b.e + 1) as T[]
  })

  const registry = new ItemRegistry()
  const vItem = createItemDirective(registry)

  const isAtLiveEdge = ref(false)
  const isPaginating = ref<Record<Direction, boolean>>({ backward: false, forward: false })
  const debugState = ref<DebugState | null>(null)

  // clientHeight is synchronous; viewportHeight lags a frame behind on first paint.
  const { height: viewportHeight } = useElementSize(container)

  const currentViewportPx = (): number => container.value?.clientHeight || viewportHeight.value || 0

  const px = (multiple: number) => multiple * currentViewportPx()

  const delay = (ms = 16): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

  /** Resolves once the container has a real, stable layout height (not a cold-load 0/tiny read). */
  async function waitForStableViewport(): Promise<void> {
    let last = -1
    let stableFor = 0
    for (let i = 0; i < 120; i++) {
      const ch = container.value?.clientHeight ?? 0
      if (ch > 1 && ch === last) {
        if (++stableFor >= 2) return
      } else {
        stableFor = 0
      }
      last = ch
      await delay(16)
    }
  }

  function readGeometry(): ScrollGeometry | null {
    const el = container.value
    if (!el) return null
    return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
  }

  /** Measured boxes for the currently-mounted window items, in scroll coords. */
  function measureWindow(): { boxes: ItemBox[]; view: { top: number; bottom: number } } | null {
    const el = container.value
    if (!el) return null
    const cRect = el.getBoundingClientRect()
    const boxes: ItemBox[] = []
    for (const item of window.value) {
      const key = getKey(item)
      const node = registry.get(key)
      if (!node) continue
      const r = node.getBoundingClientRect()
      const top = r.top - cRect.top + el.scrollTop
      boxes.push({ bottom: top + r.height, key, top })
    }
    return { boxes, view: { bottom: el.scrollTop + el.clientHeight, top: el.scrollTop } }
  }

  function windowHeightPx(boxes: ItemBox[]): number {
    if (boxes.length === 0) return 0
    return boxes.at(-1)!.bottom - boxes[0]!.top
  }

  function captureAnchor(): AnchorSnapshot | null {
    const m = measureWindow()
    if (!m || m.boxes.length === 0) return null
    const anchor = m.boxes.find(b => b.bottom > m.view.top) ?? m.boxes[0]!
    return { key: anchor.key, viewportOffset: anchor.top - m.view.top }
  }

  function setNativeAnchoring(enabled: boolean): void {
    const el = container.value
    if (el) el.style.overflowAnchor = enabled ? '' : 'none'
  }

  function restoreAnchor(snapshot: AnchorSnapshot | null): void {
    const el = container.value
    if (!el || !snapshot) return
    const node = registry.get(snapshot.key)
    if (!node) return
    const cRect = el.getBoundingClientRect()
    const r = node.getBoundingClientRect()
    const top = r.top - cRect.top + el.scrollTop
    setScrollTop(top - snapshot.viewportOffset)
  }

  /**
   * Is there already-fetched `source` content beyond the window's `dir` boundary?
   * Trimming only moves boundary keys inward, never touches `source` — so this
   * can be true independent of (and must not be gated by) the consumer's `hasMore`.
   */
  function hasBufferedOverflow(dir: Direction): boolean {
    const items = sourceItems.value
    if (items.length === 0) return false
    const b = boundIndices()
    if (!b) return false
    return dir === 'backward' ? b.s > 0 : b.e < items.length - 1
  }

  function growToEdge(dir: Direction): void {
    const maxItems = cfg.maxItems()
    const items = sourceItems.value
    const b = boundIndices()
    if (!b) return
    let { s, e } = b
    if (dir === 'backward') {
      s = 0
      if (e - s + 1 > maxItems) e = s + maxItems - 1 // drop far (bottom) overflow pre-mount
    } else {
      e = items.length - 1
      if (e - s + 1 > maxItems) s = e - (maxItems - 1) // drop far (top) overflow pre-mount
    }
    startKey.value = getKey(items[s]!)
    endKey.value = getKey(items[e]!)
  }

  /**
   * Extend the window on `dir` by at most `maxAdd` items, not all the way to
   * `source`'s edge — an unbounded reveal of buffered overflow would hand
   * trimWindow a mostly-offscreen slab it immediately trims back off.
   */
  function growToEdgeBounded(dir: Direction, maxAdd: number): void {
    const maxItems = cfg.maxItems()
    const items = sourceItems.value
    const b = boundIndices()
    if (!b) return
    let { s, e } = b
    if (dir === 'backward') {
      s = Math.max(0, s - maxAdd)
      if (e - s + 1 > maxItems) e = s + maxItems - 1 // drop far (bottom) overflow, not the growth just made
    } else {
      e = Math.min(items.length - 1, e + maxAdd)
      if (e - s + 1 > maxItems) s = e - (maxItems - 1) // drop far (top) overflow, not the growth just made
    }
    startKey.value = getKey(items[s]!)
    endKey.value = getKey(items[e]!)
  }

  /**
   * Trim both edges down toward targetHeight. `dir`, when known, is the edge
   * that was just grown — trim the stale opposite side first, and only let it
   * chase the soft targetHeight budget. The just-grown side is trimmed only
   * to enforce the hard maxItems cap: targetHeight is an aspiration satisfied
   * opportunistically from stale content, never by clawing back the runway a
   * pagination just bought (that would starve the direction the user is
   * actively scrolling into on every single pagination, not just long streaks).
   * maxItems remains the one hard invariant, enforced from either side.
   */
  function trimWindow(dir?: Direction): void {
    const maxItems = cfg.maxItems()
    const m = measureWindow()
    if (!m) return
    const { boxes, view } = m
    const items = sourceItems.value
    const b = boundIndices()
    if (!b) return
    let { s, e } = b
    let height = windowHeightPx(boxes)
    const targetPx = px(cfg.targetHeight())
    const bufferPx = px(cfg.buffer())

    // Walk inward from `side`, dropping items that are both over-budget and
    // safe to remove (fully outside viewport + buffer). `allowTargetTrim`
    // gates the soft targetHeight budget; the hard maxItems cap always applies.
    function trimSide(side: 'top' | 'bottom', allowTargetTrim: boolean): void {
      while (e - s + 1 > 1) {
        const overTarget = allowTargetTrim && height > targetPx
        const overMax = e - s + 1 > maxItems
        if (!overTarget && !overMax) break

        const idx = side === 'bottom' ? e : s
        const key = getKey(items[idx]!)
        const box = boxes.find(bx => bx.key === key)
        if (!box) break
        if (!isSafeToTrim(side, box, view, bufferPx)) break

        if (side === 'bottom') e -= 1
        else s += 1
        height -= box.bottom - box.top
      }
    }

    if (dir === 'forward') {
      trimSide('top', true)
      trimSide('bottom', false)
    } else {
      trimSide('bottom', true)
      trimSide('top', false)
    }

    startKey.value = getKey(items[s]!)
    endKey.value = getKey(items[e]!)
  }

  async function runPagination(dir: Direction, growHint?: number): Promise<void> {
    if (isPaginating.value[dir]) return
    const bufferedOverflow = hasBufferedOverflow(dir)
    if (!bufferedOverflow && !hasMoreFor(dir)) return
    const debug = cfg.debug()
    isPaginating.value = { ...isPaginating.value, [dir]: true }

    // Disable native scroll anchoring so it can't fight our manual restore (ADR-0003).
    setNativeAnchoring(false)
    try {
      const anchor = captureAnchor()

      // Buffered overflow just needs revealing — no fetch to wait on.
      if (!bufferedOverflow) {
        await onBeforePaginate(dir)
        await nextTick()
      }

      // Render clock starts once fetch has resolved and we begin mounting.
      const renderStart = debug ? performance.now() : 0

      // Grow by just enough to cover the needed runway, estimated from the
      // window's average row height (fillToTarget retries if it's not enough).
      // This applies even right after a real fetch: mounting everything a
      // fetch added in one synchronous batch (it can add far more than one
      // screenful) blocks the main thread for the whole mount+measure+trim
      // cycle — a visible freeze. Revealing only what's needed keeps each
      // mount cheap; any remainder is now buffered overflow and surfaces
      // through further cheap reveals as the user keeps scrolling.
      let addCount = growHint
      if (addCount === undefined) {
        const need = px(cfg.triggerDistance()) + px(cfg.buffer())
        const m = measureWindow()
        const avgH = m && m.boxes.length > 0 ? windowHeightPx(m.boxes) / m.boxes.length : 48
        addCount = Math.max(1, Math.ceil(need / avgH))
      }
      growToEdgeBounded(dir, addCount)
      await nextTick()

      // Restore the anchor before trimming, so trim's viewport+buffer check
      // protects the actually-visible region.
      restoreAnchor(anchor)

      trimWindow(dir)
      await nextTick()

      // Reassert in case a top-edge trim shifted content above the viewport.
      restoreAnchor(anchor)

      if (debug) recordRenderLatency(dir, performance.now() - renderStart, addCount)
    } finally {
      setNativeAnchoring(true)
      isPaginating.value = { ...isPaginating.value, [dir]: false }
      refreshDebug()
    }
  }

  /**
   * After bootstrap or a short pagination, keep paginating `dir` until the
   * paginating edge has enough runway (or we exhaust / cap). Guarded against
   * infinite loops when a fetch adds nothing.
   */
  async function fillToTarget(dir: Direction): Promise<void> {
    let guard = 0
    // Doubles when a buffered-overflow increment was too small to survive
    // trimWindow; resets once an attempt sticks.
    let overflowStep: number | undefined
    while (guard++ < 50) {
      const g = readGeometry()
      if (!g) return
      const need = px(cfg.triggerDistance()) + px(cfg.buffer())
      if (distanceToEdge(g, dir) > need) return
      if (!hasMoreFor(dir) && !hasBufferedOverflow(dir)) return

      // Track the window, not the source: a buffered-overflow reveal grows the
      // window without the source growing.
      const lenBefore = window.value.length
      await runPagination(dir, overflowStep)
      if (window.value.length === lenBefore) {
        // No progress. For a buffered-overflow reveal this can just mean the
        // increment was too small and trimWindow cut it straight back off —
        // retry bigger instead of giving up.
        if (hasBufferedOverflow(dir)) {
          overflowStep = (overflowStep ?? 1) * 2
          continue
        }
        return
      }
      overflowStep = undefined
    }
  }

  const latchReleased: Record<Direction, boolean> = { backward: true, forward: true }
  // Set for the whole fillToTarget sequence, not just one runPagination call —
  // prevents an overlapping fill starting mid-chain.
  const filling: Record<Direction, boolean> = { backward: false, forward: false }
  let lastScrollTop = 0
  let scrollDir: Direction | null = null
  let scrollScheduled = false
  let scrollTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Write scrollTop programmatically and resync `lastScrollTop` immediately,
   * so our own corrective writes aren't misread as a user scroll reversal.
   */
  function setScrollTop(value: number): void {
    const el = container.value
    if (!el) return
    el.scrollTop = value
    lastScrollTop = el.scrollTop
  }

  function onScrollFrame(): void {
    scrollScheduled = false
    const g = readGeometry()
    if (!g) return

    if (g.scrollTop < lastScrollTop) scrollDir = 'backward'
    else if (g.scrollTop > lastScrollTop) scrollDir = 'forward'
    lastScrollTop = g.scrollTop

    updateLiveEdgeFlag()

    const triggerPx = px(cfg.triggerDistance())
    for (const dir of DIRECTIONS) {
      const dist = distanceToEdge(g, dir)
      // Re-arm latch once the user has left the zone (with a little hysteresis).
      if (dist > triggerPx * 1.5) latchReleased[dir] = true

      const info = resolveTrigger({
        directionActive: scrollDir === dir,
        distanceToEdge: dist,
        hasMore: hasMoreFor(dir) || hasBufferedOverflow(dir),
        latchReleased: latchReleased[dir],
        paginating: isPaginating.value[dir] || filling[dir],
        triggerPx,
      })
      if (info.shouldFire) {
        latchReleased[dir] = false
        filling[dir] = true
        // fillToTarget, not a one-shot runPagination — chains fetches until the
        // buffer is satisfied, so a fast continuous scroll can't outrun it.
        void fillToTarget(dir).finally(() => {
          filling[dir] = false
          // Re-arm immediately: fillToTarget's own exhaustion check already
          // guards against a same-direction refire loop.
          latchReleased[dir] = true
        })
      }
    }

    refreshDebug(g)
  }

  function scheduleScrollFrame(): void {
    // setTimeout, not rAF: rAF is throttled in backgrounded tabs.
    if (scrollScheduled) return
    scrollScheduled = true
    scrollTimer = setTimeout(onScrollFrame, 16)
  }

  function updateLiveEdgeFlag(): void {
    const g = readGeometry()
    if (!g) return
    isAtLiveEdge.value = isScrolledToForwardEnd(g) && !hasMoreFor('forward') && !hasBufferedOverflow('forward')
  }

  // Watch for unsolicited source growth (items arriving on their own).
  watch(
    () => sourceItems.value.length,
    async (len, prevLen) => {
      if (len <= prevLen) return
      if (isPaginating.value.backward || isPaginating.value.forward) return // our own doing

      const atLive = isAtLiveEdge.value
      if (cfg.followTail() && atLive) {
        growToEdge('forward')
        await nextTick()
        trimWindow('forward')
        await nextTick()
        scrollToBottom()
      }
      refreshDebug()
    },
  )

  function scrollToBottom(): void {
    const el = container.value
    if (el) setScrollTop(el.scrollHeight)
  }

  async function scrollToEdge(direction: Direction): Promise<void> {
    const items = sourceItems.value
    if (items.length === 0) return
    if (direction === 'forward') {
      endKey.value = getKey(items.at(-1)!)
      startKey.value = getKey(items.at(-1)!)
    } else {
      startKey.value = getKey(items[0]!)
      endKey.value = getKey(items[0]!)
    }
    await nextTick()
    await fillToTarget(OPPOSITE[direction])
    await nextTick()
    if (direction === 'forward') scrollToBottom()
    else setScrollTop(0)
  }

  function pinToInitialEdge(): void {
    const el = container.value
    if (!el) return
    if (initialEdge === 'forward') setScrollTop(el.scrollHeight)
    else setScrollTop(0)
  }

  async function bootstrap(): Promise<void> {
    const items = sourceItems.value
    if (items.length === 0) return

    // nextTick flushes Vue's patch but not CSS layout; wait for a real height
    // before trimming, or a cold/hidden container would measure as 0.
    await waitForStableViewport()

    // Mount the whole seeded range (capped by maxItems), pin to the edge, then
    // trim to targetHeight against real measured heights.
    startKey.value = getKey(items[0]!)
    endKey.value = getKey(items.at(-1)!)
    growToEdge(initialEdge)
    await nextTick()

    pinToInitialEdge()
    await nextTick()

    trimWindow(initialEdge)
    await nextTick()

    pinToInitialEdge() // trim changed content; reassert the edge

    await fillToTarget(OPPOSITE[initialEdge])
    pinToInitialEdge()
    updateLiveEdgeFlag()
    refreshDebug()
  }

  function recordRenderLatency(dir: Direction, ms: number, added: number): void {
    const slowPaginationMs = cfg.slowPaginationMs()
    if (debugState.value) debugState.value.lastRenderMs = ms
    if (ms > slowPaginationMs) {
      const m = measureWindow()
      const count = window.value.length
      const heightAdded = m ? Math.round(windowHeightPx(m.boxes)) : 0
      const perItem = added > 0 ? (ms / added).toFixed(1) : 'n/a'
      // eslint-disable-next-line no-console
      console.warn(
        `[vue-paginated-scroll] ${dir} pagination render took ${ms.toFixed(0)}ms ` +
          `(threshold ${slowPaginationMs}ms): mounted ${added} items, window ${count} rows / ` +
          `~${heightAdded}px, avg ${perItem}ms/item. ` +
          `Consider a lighter row component or a smaller targetHeight.`,
      )
    }
  }

  function refreshDebug(g?: ScrollGeometry | null): void {
    if (!cfg.debug()) return
    const geo = g ?? readGeometry()
    if (!geo) return
    const triggerPx = px(cfg.triggerDistance())
    const m = measureWindow()
    debugState.value = {
      anchorKey: captureAnchor()?.key ?? null,
      bufferPx: px(cfg.buffer()),
      isAtLiveEdge: isAtLiveEdge.value,
      lastRenderMs: debugState.value?.lastRenderMs ?? null,
      triggers: {
        backward: resolveTrigger({
          distanceToEdge: distanceToEdge(geo, 'backward'),
          triggerPx,
          hasMore: hasMoreFor('backward') || hasBufferedOverflow('backward'),
          latchReleased: latchReleased.backward,
          directionActive: scrollDir === 'backward',
          paginating: isPaginating.value.backward || filling.backward,
        }),
        forward: resolveTrigger({
          distanceToEdge: distanceToEdge(geo, 'forward'),
          triggerPx,
          hasMore: hasMoreFor('forward') || hasBufferedOverflow('forward'),
          latchReleased: latchReleased.forward,
          directionActive: scrollDir === 'forward',
          paginating: isPaginating.value.forward || filling.forward,
        }),
      },
      viewportHeight: currentViewportPx(),
      windowCount: window.value.length,
      windowHeight: m ? Math.round(windowHeightPx(m.boxes)) : 0,
    }
  }

  useEventListener(container, 'scroll', scheduleScrollFrame, { passive: true })

  onMounted(async () => {
    await nextTick()
    await bootstrap()
  })

  // Re-bootstrap if the source arrives after mount (async seed).
  const stopSeedWatch = watch(
    () => sourceItems.value.length,
    async len => {
      if (len > 0 && startKey.value === null && endKey.value === null) {
        await bootstrap()
        stopSeedWatch()
      }
    },
  )

  onBeforeUnmount(() => {
    if (scrollTimer) clearTimeout(scrollTimer)
  })

  return {
    debugState,
    isAtLiveEdge,
    isPaginating,
    scrollToEdge,
    vItem,
    window,
  }
}
