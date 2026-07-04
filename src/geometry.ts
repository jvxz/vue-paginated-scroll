import type { Direction, TriggerDebugInfo } from './types'

/** Resolved pixel geometry of the scroll container at a moment in time. */
export interface ScrollGeometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Distance in px from the current scroll position to the given edge. */
export function distanceToEdge(g: ScrollGeometry, direction: Direction): number {
  return direction === 'backward' ? g.scrollTop : Math.max(0, g.scrollHeight - g.clientHeight - g.scrollTop)
}

/** The user is at the live edge when scrolled to (or within a hair of) the bottom. */
export function isScrolledToForwardEnd(g: ScrollGeometry, epsilonPx = 2): boolean {
  return distanceToEdge(g, 'forward') <= epsilonPx
}

export interface ArmInput {
  /** Distance to this edge in px. */
  distanceToEdge: number
  /** Fire threshold in px. */
  triggerPx: number
  /** Developer-declared: is there more to load this direction. */
  hasMore: boolean
  /** Re-arm latch: has the user left this trigger's zone since it last fired. */
  latchReleased: boolean
  /** Direction gating: is this the direction the user is currently scrolling. */
  directionActive: boolean
  /** Is a pagination already in flight this direction. */
  paginating: boolean
}

/**
 * Pure resolution of a trigger's arm state and whether it should fire *right now*.
 * All three loop-prevention layers converge here (see ADR-0002).
 */
export function resolveTrigger(input: ArmInput): TriggerDebugInfo & { shouldFire: boolean } {
  let disarmedReason: TriggerDebugInfo['disarmedReason'] = 'none'

  if (input.paginating) disarmedReason = 'paginating'
  else if (!input.hasMore) disarmedReason = 'exhausted'
  else if (!input.directionActive) disarmedReason = 'direction-gated'
  else if (!input.latchReleased) disarmedReason = 'latched'

  const armed = disarmedReason === 'none'
  const withinZone = input.distanceToEdge <= input.triggerPx
  const shouldFire = armed && withinZone

  return {
    armed,
    disarmedReason,
    distanceToEdge: input.distanceToEdge,
    shouldFire,
    triggerPx: input.triggerPx,
  }
}

/**
 * Whether an item (given its rect relative to the container's visible box) is
 * safe to trim — i.e. fully outside viewport + buffer on the trim side. This is
 * the "never trim what's visible or in buffer" invariant, in one predicate.
 *
 * `itemTop`/`itemBottom` are offsets from the container's scrollable top;
 * `viewTop`/`viewBottom` are the visible window in the same coordinate space.
 */
export function isSafeToTrim(
  side: 'top' | 'bottom',
  item: { top: number; bottom: number },
  view: { top: number; bottom: number },
  bufferPx: number,
): boolean {
  if (side === 'bottom') {
    // Trimming from the bottom: item must sit fully below the buffered viewport.
    return item.top >= view.bottom + bufferPx
  }
  // Trimming from the top: item must sit fully above the buffered viewport.
  return item.bottom <= view.top - bufferPx
}
