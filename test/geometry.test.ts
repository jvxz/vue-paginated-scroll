import { describe, it, expect } from 'vitest'

import { distanceToEdge, isSafeToTrim, resolveTrigger, isScrolledToForwardEnd } from '../src/geometry'

describe('distanceToEdge', () => {
  it('backward distance is scrollTop', () => {
    expect(distanceToEdge({ clientHeight: 400, scrollHeight: 1000, scrollTop: 120 }, 'backward')).toBe(120)
  })
  it('forward distance is remaining scroll', () => {
    expect(distanceToEdge({ clientHeight: 400, scrollHeight: 1000, scrollTop: 120 }, 'forward')).toBe(480)
  })
  it('never returns negative forward distance (overscroll)', () => {
    expect(distanceToEdge({ clientHeight: 400, scrollHeight: 1000, scrollTop: 700 }, 'forward')).toBe(0)
  })
})

describe('isScrolledToForwardEnd', () => {
  it('true at the bottom within epsilon', () => {
    expect(isScrolledToForwardEnd({ clientHeight: 400, scrollHeight: 1000, scrollTop: 599 })).toBe(true)
  })
  it('false when scrolled up', () => {
    expect(isScrolledToForwardEnd({ clientHeight: 400, scrollHeight: 1000, scrollTop: 100 })).toBe(false)
  })
})

describe('resolveTrigger — loop prevention layers (ADR-0002)', () => {
  const base = {
    directionActive: true,
    distanceToEdge: 10,
    hasMore: true,
    latchReleased: true,
    paginating: false,
    triggerPx: 100,
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
    const r = resolveTrigger({ ...base, hasMore: false, paginating: true })
    expect(r.disarmedReason).toBe('paginating')
  })
})

describe('isSafeToTrim — "never trim viewport + buffer" invariant', () => {
  const view = { bottom: 900, top: 500 }
  const bufferPx = 100

  it('bottom trim is safe only fully below the buffered viewport', () => {
    // item just below buffer edge (1000) -> safe
    expect(isSafeToTrim('bottom', { bottom: 1080, top: 1000 }, view, bufferPx)).toBe(true)
    // item intersecting the buffer zone -> unsafe
    expect(isSafeToTrim('bottom', { bottom: 1030, top: 950 }, view, bufferPx)).toBe(false)
    // item inside viewport -> unsafe (protects the read position)
    expect(isSafeToTrim('bottom', { bottom: 700, top: 600 }, view, bufferPx)).toBe(false)
  })

  it('top trim is safe only fully above the buffered viewport', () => {
    // item above buffer edge (400) -> safe
    expect(isSafeToTrim('top', { bottom: 400, top: 300 }, view, bufferPx)).toBe(true)
    // item intersecting the buffer zone -> unsafe
    expect(isSafeToTrim('top', { bottom: 460, top: 380 }, view, bufferPx)).toBe(false)
    // giant item spanning the whole viewport -> never trimmable
    expect(isSafeToTrim('top', { bottom: 2000, top: 0 }, view, bufferPx)).toBe(false)
  })
})
