import { describe, it, expect } from 'vitest'
import { distanceToEdge, isSafeToTrim, resolveTrigger, isScrolledToForwardEnd } from '../src/geometry'

describe('distanceToEdge', () => {
  it('backward distance is scrollTop', () => {
    expect(distanceToEdge({ scrollTop: 120, scrollHeight: 1000, clientHeight: 400 }, 'backward')).toBe(120)
  })
  it('forward distance is remaining scroll', () => {
    expect(distanceToEdge({ scrollTop: 120, scrollHeight: 1000, clientHeight: 400 }, 'forward')).toBe(480)
  })
  it('never returns negative forward distance (overscroll)', () => {
    expect(distanceToEdge({ scrollTop: 700, scrollHeight: 1000, clientHeight: 400 }, 'forward')).toBe(0)
  })
})

describe('isScrolledToForwardEnd', () => {
  it('true at the bottom within epsilon', () => {
    expect(isScrolledToForwardEnd({ scrollTop: 599, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
  })
  it('false when scrolled up', () => {
    expect(isScrolledToForwardEnd({ scrollTop: 100, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
  })
})

describe('resolveTrigger — loop prevention layers (ADR-0002)', () => {
  const base = {
    distanceToEdge: 10,
    triggerPx: 100,
    hasMore: true,
    latchReleased: true,
    directionActive: true,
    paginating: false,
  }

  it('fires when armed and within the zone', () => {
    const r = resolveTrigger(base)
    expect(r.armed).toBe(true)
    expect(r.shouldFire).toBe(true)
    expect(r.disarmedReason).toBe('none')
  })

  it('does not fire when outside the zone even if armed', () => {
    const r = resolveTrigger({ ...base, distanceToEdge: 200 })
    expect(r.armed).toBe(true)
    expect(r.shouldFire).toBe(false)
  })

  it('exhaustion disarms (never inferred, developer-declared)', () => {
    const r = resolveTrigger({ ...base, hasMore: false })
    expect(r.shouldFire).toBe(false)
    expect(r.disarmedReason).toBe('exhausted')
  })

  it('direction gating disarms the non-scrolled direction', () => {
    const r = resolveTrigger({ ...base, directionActive: false })
    expect(r.shouldFire).toBe(false)
    expect(r.disarmedReason).toBe('direction-gated')
  })

  it('re-arm latch disarms until the user leaves the zone', () => {
    const r = resolveTrigger({ ...base, latchReleased: false })
    expect(r.shouldFire).toBe(false)
    expect(r.disarmedReason).toBe('latched')
  })

  it('an in-flight pagination disarms', () => {
    const r = resolveTrigger({ ...base, paginating: true })
    expect(r.shouldFire).toBe(false)
    expect(r.disarmedReason).toBe('paginating')
  })

  it('precedence: paginating reported before exhaustion', () => {
    const r = resolveTrigger({ ...base, paginating: true, hasMore: false })
    expect(r.disarmedReason).toBe('paginating')
  })
})

describe('isSafeToTrim — "never trim viewport + buffer" invariant', () => {
  const view = { top: 500, bottom: 900 }
  const bufferPx = 100

  it('bottom trim is safe only fully below the buffered viewport', () => {
    // item just below buffer edge (1000) -> safe
    expect(isSafeToTrim('bottom', { top: 1000, bottom: 1080 }, view, bufferPx)).toBe(true)
    // item intersecting the buffer zone -> unsafe
    expect(isSafeToTrim('bottom', { top: 950, bottom: 1030 }, view, bufferPx)).toBe(false)
    // item inside viewport -> unsafe (protects the read position)
    expect(isSafeToTrim('bottom', { top: 600, bottom: 700 }, view, bufferPx)).toBe(false)
  })

  it('top trim is safe only fully above the buffered viewport', () => {
    // item above buffer edge (400) -> safe
    expect(isSafeToTrim('top', { top: 300, bottom: 400 }, view, bufferPx)).toBe(true)
    // item intersecting the buffer zone -> unsafe
    expect(isSafeToTrim('top', { top: 380, bottom: 460 }, view, bufferPx)).toBe(false)
    // giant item spanning the whole viewport -> never trimmable
    expect(isSafeToTrim('top', { top: 0, bottom: 2000 }, view, bufferPx)).toBe(false)
  })
})
