import type { Ref } from 'vue'

import { useElementSize, useEventListener } from '@vueuse/core'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, toValue, watch } from 'vue'

import type { ScrollGeometry } from './geometry'
import type {
  DebugState,
  Direction,
  ItemKey,
  PaginatedScroll,
  PaginatedScrollOptions,
  PaginatedScrollState,
} from './types'

import { distanceToEdge, isSafeToTrim, isScrolledToForwardEnd, resolveTrigger } from './geometry'
import { ItemRegistry, createItemDirective } from './registry'

const DIRECTIONS: Direction[] = ['backward', 'forward']
const OPPOSITE: Record<Direction, Direction> = { backward: 'forward', forward: 'backward' }

interface AnchorSnapshot {
  key: ItemKey
  /** Distance from the viewport top to the item's top, at capture time. */
  viewportOffset: number
  /** Scroll coordinate used to preserve user motion while an async fetch waits. */
  scrollTop: number
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
    if (items.length === 0 || startKey.value === null || endKey.value === null) return null
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
  let generation = 0
  let transactionDepth = 0
  let currentAnchor: AnchorSnapshot | null = null
  let bootstrapInFlight: { edge: Direction; generation: number; promise: Promise<void> } | null = null

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

  /**
   * Distance from the viewport to the rendered item-window edge. Consumer
   * chrome outside the registered rows (loading skeletons, headers, footers)
   * deliberately does not contribute.
   */
  function distanceToItemEdge(direction: Direction): number {
    const m = measureWindow()
    if (!m || m.boxes.length === 0) {
      const g = readGeometry()
      return g ? distanceToEdge(g, direction) : Number.POSITIVE_INFINITY
    }
    return direction === 'backward'
      ? Math.max(0, m.view.top - m.boxes[0]!.top)
      : Math.max(0, m.boxes.at(-1)!.bottom - m.view.bottom)
  }

  function captureAnchor(): AnchorSnapshot | null {
    const m = measureWindow()
    if (!m || m.boxes.length === 0) return null
    const visible = m.boxes.filter(b => b.bottom > m.view.top && b.top < m.view.bottom)
    if (visible.length === 0) return null
    const fullyVisible = visible.filter(b => b.top >= m.view.top && b.bottom <= m.view.bottom)
    const candidates = fullyVisible.length > 0 ? fullyVisible : visible
    const viewportCenter = (m.view.top + m.view.bottom) / 2
    const anchor = candidates.reduce((best, box) => {
      const bestDistance = Math.abs((best.top + best.bottom) / 2 - viewportCenter)
      const boxDistance = Math.abs((box.top + box.bottom) / 2 - viewportCenter)
      return boxDistance < bestDistance ? box : best
    })
    return { key: anchor.key, scrollTop: m.view.top, viewportOffset: anchor.top - m.view.top }
  }

  function setNativeAnchoring(enabled: boolean): void {
    const el = container.value
    if (el) el.style.overflowAnchor = enabled ? '' : 'none'
  }

  function restoreAnchor(snapshot: AnchorSnapshot | null, viewportOffset = snapshot?.viewportOffset): void {
    const el = container.value
    if (!el || !snapshot || viewportOffset === undefined) return
    const node = registry.get(snapshot.key)
    if (!node) return
    const cRect = el.getBoundingClientRect()
    const r = node.getBoundingClientRect()
    const top = r.top - cRect.top + el.scrollTop
    setScrollTop(top - viewportOffset)
    currentAnchor = { key: snapshot.key, scrollTop: el.scrollTop, viewportOffset }
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

  /**
   * Once content has been revealed, discard safely-offscreen stale rows until
   * the browser scrollbar reaches the direction's opposite outer quarter.
   * This is intentionally independent of the soft target-height budget.
   */
  async function rotateToLandingBand(
    dir: Direction,
    anchor: AnchorSnapshot | null,
    intendedOffset: number | undefined,
    expectedGeneration: number,
  ): Promise<void> {
    for (let guard = 0; guard < 4 && !hasReachedLandingBand(dir); guard++) {
      const m = measureWindow()
      const b = boundIndices()
      if (!m || !b) return
      const items = sourceItems.value
      const bufferPx = px(cfg.buffer())
      let { s, e } = b
      let changed = false

      if (dir === 'forward') {
        while (s < e) {
          const key = getKey(items[s]!)
          const box = m.boxes.find(candidate => candidate.key === key)
          if (!box || !isSafeToTrim('top', box, m.view, bufferPx)) break
          s++
          changed = true
        }
      } else {
        while (s < e) {
          const key = getKey(items[e]!)
          const box = m.boxes.find(candidate => candidate.key === key)
          if (!box || !isSafeToTrim('bottom', box, m.view, bufferPx)) break
          e--
          changed = true
        }
      }

      if (!changed) return
      startKey.value = getKey(items[s]!)
      endKey.value = getKey(items[e]!)
      await nextTick()
      if (expectedGeneration !== generation) return
      restoreAnchor(anchor, intendedOffset)
    }
  }

  async function runPagination(
    dir: Direction,
    growHint?: number,
    expectedGeneration = generation,
    landing = false,
  ): Promise<void> {
    if (expectedGeneration !== generation || isPaginating.value[dir]) return
    const bufferedOverflow = hasBufferedOverflow(dir)
    if (!bufferedOverflow && !hasMoreFor(dir)) return
    const debug = cfg.debug()
    isPaginating.value = { ...isPaginating.value, [dir]: true }
    transactionDepth++

    // Disable native scroll anchoring so it can't fight our manual restore (ADR-0003).
    setNativeAnchoring(false)
    // Capture before calling consumer code: the callback may change other DOM
    // at the edge (for example removing a loading skeleton) before it resolves.
    const anchor = captureAnchor()
    try {
      // Buffered overflow just needs revealing — no fetch to wait on.
      if (!bufferedOverflow) {
        await onBeforePaginate(dir)
      }
      if (expectedGeneration !== generation) return

      // Preserve user motion that occurred while the request was pending,
      // without measuring after consumer DOM has already changed.
      const scrollDelta = anchor && container.value ? container.value.scrollTop - anchor.scrollTop : 0
      const intendedOffset = anchor ? anchor.viewportOffset - scrollDelta : undefined
      await nextTick()
      if (expectedGeneration !== generation) return

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
      if (expectedGeneration !== generation) return

      // Restore the anchor before trimming, so trim's viewport+buffer check
      // protects the actually-visible region.
      restoreAnchor(anchor, intendedOffset)

      trimWindow(dir)
      await nextTick()
      if (expectedGeneration !== generation) return

      // Reassert in case a top-edge trim shifted content above the viewport.
      restoreAnchor(anchor, intendedOffset)
      if (landing) await rotateToLandingBand(dir, anchor, intendedOffset, expectedGeneration)

      if (debug) recordRenderLatency(dir, performance.now() - renderStart, addCount)
    } finally {
      if (expectedGeneration === generation) {
        transactionDepth = Math.max(0, transactionDepth - 1)
        if (transactionDepth === 0) setNativeAnchoring(true)
        isPaginating.value = { ...isPaginating.value, [dir]: false }
        currentAnchor = captureAnchor()
        refreshDebug()
      }
    }
  }

  /**
   * After bootstrap or a short pagination, keep paginating `dir` until the
   * paginating edge has enough runway (or we exhaust / cap). Guarded against
   * infinite loops when a fetch adds nothing.
   */
  function normalizedScrollPosition(): number {
    const g = readGeometry()
    if (!g) return 0
    const range = Math.max(0, g.scrollHeight - g.clientHeight)
    return range === 0 ? 0 : Math.max(0, Math.min(1, g.scrollTop / range))
  }

  function hasReachedLandingBand(dir: Direction): boolean {
    const position = normalizedScrollPosition()
    return dir === 'backward' ? position >= 0.75 : position <= 0.25
  }

  async function fillToTarget(
    dir: Direction,
    opts: { expectedGeneration?: number; forceFirst?: boolean; landing?: boolean } = {},
  ): Promise<void> {
    const expectedGeneration = opts.expectedGeneration ?? generation
    let guard = 0
    let attempted = false
    // Doubles when a buffered-overflow increment was too small to survive
    // trimWindow; resets once an attempt sticks.
    let overflowStep: number | undefined
    while (guard++ < 50) {
      if (expectedGeneration !== generation) return
      const need = px(cfg.triggerDistance()) + px(cfg.buffer())
      if (attempted || !opts.forceFirst) {
        if (opts.landing ? hasReachedLandingBand(dir) : distanceToItemEdge(dir) > need) return
      }
      if (!hasMoreFor(dir) && !hasBufferedOverflow(dir)) return

      // Track the window, not the source: a buffered-overflow reveal grows the
      // window without the source growing.
      const lenBefore = window.value.length
      const sourceLenBefore = sourceItems.value.length
      const startBefore = startKey.value
      const endBefore = endKey.value
      const scrollBefore = container.value?.scrollTop
      await runPagination(dir, overflowStep, expectedGeneration, opts.landing)
      attempted = true
      const madeProgress =
        window.value.length !== lenBefore ||
        sourceItems.value.length !== sourceLenBefore ||
        startKey.value !== startBefore ||
        endKey.value !== endBefore ||
        container.value?.scrollTop !== scrollBefore
      if (!madeProgress) {
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
  // See redriveIfUnscrollable: consecutive fills that left the container with no
  // scrollable range, per direction.
  const idleFills: Record<Direction, number> = { backward: 0, forward: 0 }
  const MAX_IDLE_FILLS = 8
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

  const rowHeights = new Map<ItemKey, number>()
  const keyByElement = new WeakMap<HTMLElement, ItemKey>()
  let rowResizeObserver: ResizeObserver | null = null

  function ensureRowResizeObserver(): ResizeObserver | null {
    if (rowResizeObserver || typeof ResizeObserver === 'undefined') return rowResizeObserver
    rowResizeObserver = new ResizeObserver(entries => {
      const wasAtLiveEdge = isAtLiveEdge.value
      const anchor = currentAnchor
      const anchorIndex = anchor ? keyToIndex.value.get(anchor.key) : undefined
      let deltaAboveAnchor = 0

      for (const entry of entries) {
        const element = entry.target as HTMLElement
        const key = keyByElement.get(element)
        if (key === undefined) continue
        const nextHeight = element.getBoundingClientRect().height
        const previousHeight = rowHeights.get(key) ?? nextHeight
        rowHeights.set(key, nextHeight)
        if (transactionDepth > 0 || anchorIndex === undefined) continue

        const itemIndex = keyToIndex.value.get(key)
        if (itemIndex !== undefined && itemIndex < anchorIndex) deltaAboveAnchor += nextHeight - previousHeight
      }

      if (transactionDepth > 0) return
      if (wasAtLiveEdge) scrollToBottom()
      else if (Math.abs(deltaAboveAnchor) > 0.01 && container.value) {
        setScrollTop(container.value.scrollTop + deltaAboveAnchor)
      }
      updateLiveEdgeFlag()
      currentAnchor = captureAnchor()
      refreshDebug()
    })
    return rowResizeObserver
  }

  registry.onRegister = (key, element) => {
    keyByElement.set(element, key)
    rowHeights.set(key, element.getBoundingClientRect().height)
    ensureRowResizeObserver()?.observe(element)
  }
  registry.onUnregister = (key, element) => {
    rowResizeObserver?.unobserve(element)
    keyByElement.delete(element)
    rowHeights.delete(key)
  }

  function syncRowHeights(): void {
    for (const item of window.value) {
      const key = getKey(item)
      const element = registry.get(key)
      if (element) rowHeights.set(key, element.getBoundingClientRect().height)
    }
  }

  /**
   * Every fire path runs inside a scroll frame, and scroll frames only happen on
   * scroll events. A window shorter than the viewport has no scrollable range, so
   * no scroll event can ever arrive — pagination parks with its trigger armed and
   * `shouldFire` true, forever. Re-drive the frame ourselves in that state.
   *
   * Bounded per direction so a source that genuinely cannot fill the viewport
   * settles instead of spinning; the count resets as soon as content overflows.
   */
  function redriveIfUnscrollable(dir: Direction, expectedGeneration: number): void {
    if (expectedGeneration !== generation) return

    const g = readGeometry()
    if (g && g.scrollHeight - g.clientHeight > 1) {
      idleFills[dir] = 0
      return
    }
    if (!hasMoreFor(dir) && !hasBufferedOverflow(dir)) return
    if (idleFills[dir]++ >= MAX_IDLE_FILLS) return

    scrollDir = dir
    scheduleScrollFrame()
  }

  function onScrollFrame(): void {
    scrollScheduled = false
    const g = readGeometry()
    if (!g) return

    if (g.scrollTop < lastScrollTop) scrollDir = 'backward'
    else if (g.scrollTop > lastScrollTop) scrollDir = 'forward'
    lastScrollTop = g.scrollTop

    updateLiveEdgeFlag()
    if (transactionDepth === 0) currentAnchor = captureAnchor()

    const triggerPx = px(cfg.triggerDistance())
    for (const dir of DIRECTIONS) {
      const dist = distanceToItemEdge(dir)
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
        const expectedGeneration = generation
        void fillToTarget(dir, { expectedGeneration, forceFirst: true, landing: true }).finally(() => {
          filling[dir] = false
          // Re-arm immediately: fillToTarget's own exhaustion check already
          // guards against a same-direction refire loop.
          latchReleased[dir] = true
          redriveIfUnscrollable(dir, expectedGeneration)
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

  function pinToEdge(edge: Direction): void {
    const el = container.value
    if (!el) return
    if (edge === 'forward') setScrollTop(el.scrollHeight)
    else setScrollTop(0)
  }

  async function performBootstrap(expectedGeneration: number, edge: Direction): Promise<void> {
    const items = sourceItems.value
    if (items.length === 0) return

    // nextTick flushes Vue's patch but not CSS layout; wait for a real height
    // before trimming, or a cold/hidden container would measure as 0.
    await waitForStableViewport()
    if (expectedGeneration !== generation) return

    // Mount the whole seeded range (capped by maxItems), pin to the edge, then
    // trim to targetHeight against real measured heights.
    startKey.value = getKey(items[0]!)
    endKey.value = getKey(items.at(-1)!)
    growToEdge(edge)
    await nextTick()
    if (expectedGeneration !== generation) return

    pinToEdge(edge)
    await nextTick()
    if (expectedGeneration !== generation) return

    trimWindow(edge)
    await nextTick()
    if (expectedGeneration !== generation) return

    pinToEdge(edge) // trim changed content; reassert the edge

    await fillToTarget(OPPOSITE[edge], { expectedGeneration })
    if (expectedGeneration !== generation) return
    pinToEdge(edge)
    syncRowHeights()
    updateLiveEdgeFlag()
    currentAnchor = captureAnchor()
    refreshDebug()
  }

  function bootstrap(expectedGeneration = generation, edge: Direction = initialEdge): Promise<void> {
    const active = bootstrapInFlight
    if (active?.generation === expectedGeneration && active.edge === edge) return active.promise

    const task: Promise<void> = performBootstrap(expectedGeneration, edge).finally(() => {
      if (bootstrapInFlight?.promise === task) bootstrapInFlight = null
      // A bootstrap that lands shorter than the viewport leaves nothing to
      // scroll, so no scroll frame will ever run to notice there is more.
      redriveIfUnscrollable(OPPOSITE[edge], expectedGeneration)
    })
    bootstrapInFlight = { edge, generation: expectedGeneration, promise: task }
    return task
  }

  function invalidate(): number {
    generation++
    bootstrapInFlight = null
    transactionDepth = 0
    setNativeAnchoring(true)
    startKey.value = null
    endKey.value = null
    latchReleased.backward = true
    latchReleased.forward = true
    filling.backward = false
    filling.forward = false
    idleFills.backward = 0
    idleFills.forward = 0
    isPaginating.value = { backward: false, forward: false }
    isAtLiveEdge.value = false
    scrollDir = null
    currentAnchor = null
    rowHeights.clear()
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = null
    scrollScheduled = false
    return generation
  }

  function captureState(): PaginatedScrollState | null {
    const anchor = captureAnchor()
    const g = readGeometry()
    if (!anchor || !g || startKey.value === null || endKey.value === null) return null
    return {
      anchorKey: anchor.key,
      anchorViewportOffset: anchor.viewportOffset,
      atLiveEdge: isAtLiveEdge.value,
      scrollTop: g.scrollTop,
      windowEndKey: endKey.value,
      windowStartKey: startKey.value,
    }
  }

  async function reset(): Promise<void> {
    const expectedGeneration = invalidate()
    await nextTick()
    await bootstrap(expectedGeneration)
  }

  async function restoreState(state: PaginatedScrollState): Promise<boolean> {
    const expectedGeneration = invalidate()
    await nextTick()

    if (state.atLiveEdge) {
      await bootstrap(expectedGeneration, 'forward')
      return expectedGeneration === generation
    }

    const items = sourceItems.value
    const anchorIndex = keyToIndex.value.get(state.anchorKey)
    if (anchorIndex === undefined) {
      await bootstrap(expectedGeneration)
      return false
    }

    const savedStart = keyToIndex.value.get(state.windowStartKey)
    const savedEnd = keyToIndex.value.get(state.windowEndKey)
    let s = savedStart ?? Math.max(0, anchorIndex - Math.floor(cfg.maxItems() / 2))
    let e = savedEnd ?? Math.min(items.length - 1, s + cfg.maxItems() - 1)
    if (s > anchorIndex || e < anchorIndex || s > e) {
      s = Math.max(0, anchorIndex - Math.floor(cfg.maxItems() / 2))
      e = Math.min(items.length - 1, s + cfg.maxItems() - 1)
    }
    if (e - s + 1 > cfg.maxItems()) {
      s = Math.max(s, anchorIndex - Math.floor((cfg.maxItems() - 1) / 2))
      e = Math.min(items.length - 1, s + cfg.maxItems() - 1)
    }

    startKey.value = getKey(items[s]!)
    endKey.value = getKey(items[e]!)
    await nextTick()
    await waitForStableViewport()
    if (expectedGeneration !== generation) return false

    // Try the exact numeric coordinate first, then correct against content
    // identity so layout changes cannot move the saved event.
    setScrollTop(state.scrollTop)
    await nextTick()
    restoreAnchor(
      { key: state.anchorKey, scrollTop: state.scrollTop, viewportOffset: state.anchorViewportOffset },
      state.anchorViewportOffset,
    )
    syncRowHeights()
    updateLiveEdgeFlag()
    refreshDebug()
    return true
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
          directionActive: scrollDir === 'backward',
          distanceToEdge: distanceToItemEdge('backward'),
          hasMore: hasMoreFor('backward') || hasBufferedOverflow('backward'),
          latchReleased: latchReleased.backward,
          paginating: isPaginating.value.backward || filling.backward,
          triggerPx,
        }),
        forward: resolveTrigger({
          directionActive: scrollDir === 'forward',
          distanceToEdge: distanceToItemEdge('forward'),
          hasMore: hasMoreFor('forward') || hasBufferedOverflow('forward'),
          latchReleased: latchReleased.forward,
          paginating: isPaginating.value.forward || filling.forward,
          triggerPx,
        }),
      },
      viewportHeight: currentViewportPx(),
      windowCount: window.value.length,
      windowHeight: m ? Math.round(windowHeightPx(m.boxes)) : 0,
    }
  }

  useEventListener(container, 'scroll', scheduleScrollFrame, { passive: true })

  // `hasMore` commonly flips true after mount, once the consumer knows whether
  // older data exists. If the container is unscrollable at that moment there is
  // no scroll event coming to act on it, so re-drive here as well.
  watch(
    () => DIRECTIONS.map(dir => hasMoreFor(dir)),
    () => {
      for (const dir of DIRECTIONS) redriveIfUnscrollable(dir, generation)
    },
  )

  // Browsers clamp setTimeout to >=1s in a hidden tab (and to ~1/minute after a
  // few minutes), so a scroll that lands while hidden can leave the frame
  // pending and the window stale until the next scroll. Run one directly on the
  // way back to visible rather than waiting for the user to scroll again.
  useEventListener(
    () => (typeof document === 'undefined' ? null : document),
    'visibilitychange',
    () => {
      if (document.visibilityState !== 'visible') return
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = null
      scrollScheduled = false
      onScrollFrame()
    },
  )

  onMounted(async () => {
    await nextTick()
    await reset()
  })

  // Re-bootstrap whenever a reset source receives its asynchronous seed.
  watch(
    () => sourceItems.value.length,
    async len => {
      if (len > 0 && startKey.value === null && endKey.value === null) {
        await bootstrap(generation)
      }
    },
  )

  onBeforeUnmount(() => {
    if (scrollTimer) clearTimeout(scrollTimer)
    rowResizeObserver?.disconnect()
  })

  return {
    captureState,
    debugState,
    isAtLiveEdge,
    isPaginating,
    reset,
    restoreState,
    scrollToEdge,
    vItem,
    window,
  }
}
