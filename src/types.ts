import type { MaybeRefOrGetter, Ref, ComputedRef } from 'vue'

/** Stable identity for an item. Never the array index. */
export type ItemKey = string | number

/**
 * `backward` loads at the top edge (older items), `forward` loads at the
 * bottom edge (newer items).
 */
export type Direction = 'backward' | 'forward'

/** Which edge the window anchors to on mount. */
export type Edge = 'backward' | 'forward'

export interface PaginatedScrollOptions<T> {
  /**
   * The backing array. Only mutated inside {@link onBeforePaginate}.
   */
  source: MaybeRefOrGetter<readonly T[]>

  /**
   * Returns a stable key for an item.
   */
  getKey: (item: T) => ItemKey

  /**
   * Fetch a page and mutate `source` (prepend for `backward`, append for
   * `forward`). Awaited, then the window recomputes.
   */
  onBeforePaginate: (direction: Direction) => void | Promise<void>

  /**
   * Is there more to load in this direction.
   *
   * @default () => true
   */
  hasMore?: (direction: Direction) => MaybeRefOrGetter<boolean>

  /**
   * Target rendered window height, in viewport heights. Reactive.
   *
   * @default 3
   */
  targetHeight?: MaybeRefOrGetter<number>

  /**
   * Runway kept on the opposite side of scroll, in viewport heights. Reactive.
   *
   * @default 0.3
   */
  buffer?: MaybeRefOrGetter<number>

  /**
   * How close to an edge, in viewport heights, triggers a pagination. Reactive.
   *
   * @default 0.5
   */
  triggerDistance?: MaybeRefOrGetter<number>

  /**
   * Hard ceiling on mounted rows. Reactive.
   *
   * @default 250
   */
  maxItems?: MaybeRefOrGetter<number>

  /**
   * Edge to anchor to on first mount.
   *
   * @default 'forward'
   */
  initialEdge?: Edge

  /**
   * Re-pin to the bottom when new items arrive while at the live edge. Reactive.
   *
   * @default false
   */
  followTail?: MaybeRefOrGetter<boolean>

  /**
   * Enable the dev overlay state and render-latency warnings. Reactive.
   *
   * @default false
   */
  debug?: MaybeRefOrGetter<boolean>

  /**
   * Render-latency warning threshold in ms. Reactive.
   *
   * @default 50
   */
  slowPaginationMs?: MaybeRefOrGetter<number>
}

/**
 * Serializable bookmark for restoring a bounded window without depending on
 * the scroll container having exactly the same height as when it was saved.
 */
export interface PaginatedScrollState {
  /** The item pinned when the state was captured. */
  anchorKey: ItemKey
  /** The item's top offset from the viewport top, in CSS pixels. */
  anchorViewportOffset: number
  /** Exact-coordinate fast path when the restored layout is unchanged. */
  scrollTop: number
  /** A live-edge bookmark follows newly-arrived items on restore. */
  atLiveEdge: boolean
  /** Saved bounded-window edges, used when they still exist in the source. */
  windowStartKey: ItemKey
  windowEndKey: ItemKey
}

/** A trigger zone's live geometry + arm state, for the debug overlay. */
export interface TriggerDebugInfo {
  /** Distance in px from the current scroll position to this edge. */
  distanceToEdge: number
  /** The px threshold at which this trigger fires. */
  triggerPx: number
  /** Whether this trigger is currently allowed to fire. */
  armed: boolean
  /** Why it's disarmed, when it is. */
  disarmedReason: 'none' | 'exhausted' | 'latched' | 'direction-gated' | 'paginating'
}

/** Snapshot of live pagination state, for the debug overlay. */
export interface DebugState {
  bufferPx: number
  viewportHeight: number
  windowHeight: number
  windowCount: number
  anchorKey: ItemKey | null
  isAtLiveEdge: boolean
  lastRenderMs: number | null
  triggers: Record<Direction, TriggerDebugInfo>
}

export interface PaginatedScroll<T> {
  /** The bounded slice to render. `v-for` over this; each row gets `v-pgs-item`. */
  readonly window: ComputedRef<T[]>
  /** At the newest item, scrolled to the bottom. */
  readonly isAtLiveEdge: Ref<boolean>
  /** A pagination is in flight, per direction. */
  readonly isPaginating: Ref<Record<Direction, boolean>>
  /** Directive for each row: `v-pgs-item="getKey(item)"`. */
  readonly vItem: import('vue').Directive<HTMLElement, ItemKey>
  /** Scroll to an edge, paginating as needed to reach it. */
  scrollToEdge: (direction: Direction) => Promise<void>
  /** State for `<PaginatedScrollDebug>`. `null` unless `debug` is on. */
  readonly debugState: Ref<DebugState | null>
  /** Capture the current content-relative scroll bookmark. */
  captureState: () => PaginatedScrollState | null
  /**
   * Invalidate old work and restore a bookmark against the current source.
   * Returns false after falling back to `initialEdge` when the anchor is stale.
   */
  restoreState: (state: PaginatedScrollState) => Promise<boolean>
  /** Invalidate old work and bootstrap the current source at `initialEdge`. */
  reset: () => Promise<void>
}
