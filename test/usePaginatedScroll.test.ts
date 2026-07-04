import type { VNode } from 'vue'

import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef, withDirectives } from 'vue'

import { usePaginatedScroll } from '../src/usePaginatedScroll'

const VIEWPORT = 800
const TARGET_MULTIPLE = 3
const TARGET_PX = TARGET_MULTIPLE * VIEWPORT

function heightFor(id: number): number {
  const r = ((id * 2654435761) % 1000) / 1000
  if (r > 0.94) return 380 // occasional giant "rules"-style block
  if (r > 0.82) return 200 // occasional image-style block
  return 48 // ordinary text row
}

/**
 * Minimal block-layout simulation for happy-dom (which does no real layout):
 * item elements are tagged with `data-h`, and `getBoundingClientRect` for any
 * tagged element is computed from cumulative `data-h` of preceding siblings,
 * minus the container's scrollTop. Patched onto the prototype (not per-
 * instance) since Vue creates item elements later and there's no hook to
 * intercept each one individually.
 */
function installLayoutStub(container: HTMLElement, scrollTopRef: { value: number }) {
  Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => VIEWPORT })
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTopRef.value,
    // Real browsers fire a 'scroll' event on programmatic writes too — mirror
    // that here, since the library's own corrective writes (restoreAnchor,
    // edge jumps) need to be observable to onScrollFrame just like a user's.
    set: v => {
      scrollTopRef.value = v
      container.dispatchEvent(new Event('scroll'))
    },
    configurable: true,
  })
  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: () => {
      let total = 0
      for (const child of Array.from(container.children)) {
        total += Number((child as HTMLElement).dataset.h ?? 0)
      }
      return total
    },
  })

  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this === container) {
      return {
        bottom: VIEWPORT,
        height: VIEWPORT,
        left: 0,
        right: 0,
        toJSON() {},
        top: 0,
        width: 0,
        x: 0,
        y: 0,
      } as DOMRect
    }
    if (this.dataset.h !== undefined && this.parentElement === container) {
      let top = 0
      for (const child of [...container.children]) {
        if (child === this) break
        top += Number((child as HTMLElement).dataset.h ?? 0)
      }
      const height = Number(this.dataset.h ?? 0)
      const scrollTop = scrollTopRef.value
      return {
        bottom: top - scrollTop + height,
        height,
        left: 0,
        right: 0,
        toJSON() {},
        top: top - scrollTop,
        width: 0,
        x: 0,
        y: 0,
      } as DOMRect
    }
    return { bottom: 0, height: 0, left: 0, right: 0, toJSON() {}, top: 0, width: 0, x: 0, y: 0 } as DOMRect
  }
}

describe('usePaginatedScroll — trim tuning', () => {
  it('keeps the window near targetHeight through a repeated same-direction pagination streak', async () => {
    const LIVE_EDGE = 5999
    const SEED = 40
    const ALL_IDS = Array.from({ length: LIVE_EDGE + 1 }, (_, i) => i)

    const source = shallowRef(ALL_IDS.slice(LIVE_EDGE - SEED + 1, LIVE_EDGE + 1))
    const canOlder = ref(true)
    const scrollTopRef = { value: 0 }

    const Comp = defineComponent({
      render() {
        const items: VNode[] = this.window.map((id: number) =>
          withDirectives(h('div', { key: id, 'data-h': heightFor(id) }), [[this.vItem, id]]),
        )
        return h('div', { ref: 'container', style: `height:${VIEWPORT}px` }, items)
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        const api = usePaginatedScroll(container, {
          source,
          getKey: (id: number) => id,
          onBeforePaginate: async dir => {
            if (dir !== 'backward') return
            const first = source.value[0]!
            const start = Math.max(0, first - 30)
            if (start === first) {
              canOlder.value = false
              return
            }
            source.value = [...ALL_IDS.slice(start, first), ...source.value]
            canOlder.value = start > 0
          },
          hasMore: dir => (dir === 'backward' ? canOlder.value : false),
          targetHeight: TARGET_MULTIPLE,
          buffer: 0.3,
          triggerDistance: 0.5,
          maxItems: 250,
          initialEdge: 'forward',
        })
        return { container, ...api }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayoutStub(container, scrollTopRef)
    await nextTick()
    await new Promise(r => setTimeout(r, 300)) // waitForStableViewport + bootstrap fill

    function currentHeight(): number {
      const firstRect = (container.children[0] as HTMLElement)?.getBoundingClientRect()
      const lastRect = (container.children.at(-1) as HTMLElement)?.getBoundingClientRect()
      if (!firstRect || !lastRect) return 0
      return lastRect.bottom - firstRect.top
    }

    // Drive 10 rounds of backward-only pagination: scroll into the trigger
    // zone, let the async pagination settle, then scroll away to re-arm the
    // latch before the next round.
    for (let round = 0; round < 10; round++) {
      scrollTopRef.value = 0
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 200))
      scrollTopRef.value = 9999
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 60))
    }

    // Before the fix this compounded well past 2x targetHeight over a same-
    // direction streak because the grown (near) edge was never trimmed —
    // only the far edge was. Allow generous slack for buffer/item-size
    // granularity without re-permitting that unbounded growth.
    expect(currentHeight()).toBeLessThan(TARGET_PX * 1.3)
  })
})

describe('usePaginatedScroll — forward growth from buffered overflow', () => {
  it('regrows the forward edge back into already-fetched content trimmed away during a backward streak, with no forward fetch available', async () => {
    // Small enough history that the backward streak below can fully exhaust
    // it (canOlder -> false) within the round budget.
    const LIVE_EDGE = 200
    const SEED = 40
    const ALL_IDS = Array.from({ length: LIVE_EDGE + 1 }, (_, i) => i)

    const source = shallowRef(ALL_IDS.slice(LIVE_EDGE - SEED + 1, LIVE_EDGE + 1))
    const canOlder = ref(true)
    const scrollTopRef = { value: 0 }

    const Comp = defineComponent({
      render() {
        const items: VNode[] = this.window.map((id: number) =>
          withDirectives(h('div', { key: id, 'data-h': heightFor(id) }), [[this.vItem, id]]),
        )
        return h('div', { ref: 'container', style: `height:${VIEWPORT}px` }, items)
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        const api = usePaginatedScroll(container, {
          source,
          getKey: (id: number) => id,
          onBeforePaginate: async dir => {
            // Forward never fetches — hasMore('forward') is always false, so
            // any forward growth observed below can only come from revealing
            // already-fetched buffered overflow, not a fetch.
            if (dir !== 'backward') return
            const first = source.value[0]!
            const start = Math.max(0, first - 30)
            if (start === first) {
              canOlder.value = false
              return
            }
            source.value = [...ALL_IDS.slice(start, first), ...source.value]
            canOlder.value = start > 0
          },
          hasMore: dir => (dir === 'backward' ? canOlder.value : false),
          targetHeight: TARGET_MULTIPLE,
          buffer: 0.3,
          triggerDistance: 0.5,
          maxItems: 250,
          initialEdge: 'forward',
        })
        return { container, ...api }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayoutStub(container, scrollTopRef)
    await nextTick()
    await new Promise(r => setTimeout(r, 300)) // waitForStableViewport + bootstrap fill

    // Drive a long backward-only streak (same pattern as the trim-tuning
    // test above) until history is exhausted. This leaves the window's
    // forward edge — trimmed as stale on every round of that streak — well
    // behind the source's actual fetched-forward boundary (LIVE_EDGE).
    for (let round = 0; round < 40; round++) {
      scrollTopRef.value = 0
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 200))
      // Re-arm the backward latch by moving past its hysteresis threshold
      // (triggerPx * 1.5 = 600px) — but stay well short of the forward edge's
      // own trigger zone, or this swing spuriously arms a forward
      // buffered-overflow reveal that immediately trims the backward growth
      // this round just made (see ADR-0002 direction gating).
      scrollTopRef.value = 700
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 60))
      if (!canOlder.value) break
    }

    expect(canOlder.value).toBe(false) // confirms a genuinely long streak happened
    const lastIdAfterBackward = wrapper.vm.window.at(-1)
    expect(lastIdAfterBackward).toBeLessThan(LIVE_EDGE)

    // Re-seed lastScrollTop at the current (post-streak) position: the loop
    // above ends on a direct scrollTop assignment, which doesn't dispatch a
    // 'scroll' event, so without this the next jump would be compared
    // against a stale lastScrollTop and could misdetect direction.
    container.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 30))

    // Scroll forward continuously, clamping to the native ceiling each tick
    // like a real browser would — this is what previously produced a
    // partial-growth-then-permanent-plateau instead of reaching LIVE_EDGE.
    // Step size matters: a jump big enough to skip past the re-arm
    // hysteresis window (triggerPx * 1.5 - triggerPx = 200px) in one tick can
    // land back inside the trigger zone without ever being sampled while
    // re-armable. Settling on Vue's own microtask queue (nextTick), rather
    // than a fixed real-time sleep, avoids racing multiple ticks' worth of
    // scrollTop advancing against an in-flight fill's async settle — a real-
    // time wait that's too short compounds into the same overshoot, flakily.
    for (let i = 0; i < 200; i++) {
      const ceiling = Math.max(0, container.scrollHeight - container.clientHeight)
      scrollTopRef.value = Math.min(ceiling, scrollTopRef.value + 150)
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 20)) // let scheduleScrollFrame's debounce timer fire
      for (let settle = 0; settle < 50 && wrapper.vm.isPaginating.forward; settle++) {
        await nextTick()
      }
      await nextTick()
      await nextTick()
      if (wrapper.vm.isAtLiveEdge) break
    }
    await new Promise(r => setTimeout(r, 200))

    expect(wrapper.vm.window.at(-1)).toBe(LIVE_EDGE)
    expect(wrapper.vm.isAtLiveEdge).toBe(true)
  }, 20000)
})

describe('usePaginatedScroll — fast-scroll re-arm', () => {
  it('keeps revealing buffered backward content after a fast scroll burst lands in the trigger zone and stops, instead of latching stuck', async () => {
    const LIVE_EDGE = 400
    const SEED = 40
    const ALL_IDS = Array.from({ length: LIVE_EDGE + 1 }, (_, i) => i)

    const source = shallowRef(ALL_IDS.slice(LIVE_EDGE - SEED + 1, LIVE_EDGE + 1))
    const canOlder = ref(true)
    const scrollTopRef = { value: 0 }

    const Comp = defineComponent({
      render() {
        const items: VNode[] = this.window.map((id: number) =>
          withDirectives(h('div', { key: id, 'data-h': heightFor(id) }), [[this.vItem, id]]),
        )
        return h('div', { ref: 'container', style: `height:${VIEWPORT}px` }, items)
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        const api = usePaginatedScroll(container, {
          source,
          getKey: (id: number) => id,
          onBeforePaginate: async dir => {
            // Forward never fetches — any forward growth below can only come
            // from revealing already-fetched buffered overflow.
            if (dir !== 'backward') return
            const first = source.value[0]!
            const start = Math.max(0, first - 30)
            if (start === first) {
              canOlder.value = false
              return
            }
            source.value = [...ALL_IDS.slice(start, first), ...source.value]
            canOlder.value = start > 0
          },
          hasMore: dir => (dir === 'backward' ? canOlder.value : false),
          targetHeight: TARGET_MULTIPLE,
          buffer: 0.3,
          triggerDistance: 0.5,
          maxItems: 250,
          initialEdge: 'forward',
          debug: true,
        })
        return { container, ...api }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayoutStub(container, scrollTopRef)
    await nextTick()
    await new Promise(r => setTimeout(r, 300)) // waitForStableViewport + bootstrap fill

    // Phase 1: a long backward-only streak builds deep history in `source`
    // while trimWindow's bottom-first trim (dir === 'backward') shrinks the
    // window's own forward/bottom edge inward — the same mechanism the
    // "forward growth from buffered overflow" test above exploits, just
    // building the overflow up rather than exhausting it.
    for (let round = 0; round < 8; round++) {
      scrollTopRef.value = 0
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 200))
      scrollTopRef.value = 700
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 60))
    }
    const startAfterBuildup = wrapper.vm.window[0]!
    expect(startAfterBuildup).toBeLessThan(LIVE_EDGE - SEED + 1) // real backward depth was fetched

    // Phase 2: scroll to the bottom repeatedly. There's no real forward fetch
    // (hasMore('forward') is always false), so this reveals forward buffered
    // overflow and — critically — trimWindow's top-first trim (dir ===
    // 'forward') shrinks the window's backward/top edge back inward, leaving
    // a large gap of already-fetched-but-unrendered content behind it.
    for (let round = 0; round < 6; round++) {
      scrollTopRef.value = Math.max(0, container.scrollHeight - container.clientHeight)
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 200))
    }
    const startAfterForwardTrim = wrapper.vm.window[0]!
    expect(startAfterForwardTrim).toBeGreaterThan(startAfterBuildup) // backward edge was trimmed forward, leaving buffered overflow behind it

    // Phase 3: a single fast scroll burst straight to the top, then stop —
    // mimicking a quick fling or a middle-mouse autoscroll that ends right as
    // it reaches the top. Before the fix, a bounded buffered-overflow reveal
    // that only partially satisfied the needed runway left the latch stuck
    // disarmed once this burst ended, permanently stalling further reveals.
    container.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 30))
    const burstStart = scrollTopRef.value
    for (let i = 1; i <= 50; i++) {
      scrollTopRef.value = Math.max(0, burstStart - (burstStart * i) / 50)
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 2))
    }
    scrollTopRef.value = 0
    container.dispatchEvent(new Event('scroll'))

    // No further scroll input at all — settle passively, as a real gesture
    // that has ended would.
    for (let i = 0; i < 30 && wrapper.vm.debugState?.triggers.backward.disarmedReason === 'latched'; i++) {
      await new Promise(r => setTimeout(r, 100))
    }

    expect(wrapper.vm.window[0]).toBeLessThan(startAfterForwardTrim) // kept revealing, not stuck
    expect(wrapper.vm.debugState?.triggers.backward.disarmedReason).not.toBe('latched')
  }, 20000)
})

describe('usePaginatedScroll — direction gating vs self-inflicted scrollTop writes', () => {
  it('keeps paginating forward through a continuous push, instead of direction-gating itself shut on its own anchor-restore correction', async () => {
    const LIVE_EDGE = 400
    const SEED = 40
    const ALL_IDS = Array.from({ length: LIVE_EDGE + 1 }, (_, i) => i)

    const source = shallowRef(ALL_IDS.slice(LIVE_EDGE - SEED + 1, LIVE_EDGE + 1))
    const canOlder = ref(true)
    const scrollTopRef = { value: 0 }

    const Comp = defineComponent({
      render() {
        const items: VNode[] = this.window.map((id: number) =>
          withDirectives(h('div', { key: id, 'data-h': heightFor(id) }), [[this.vItem, id]]),
        )
        return h('div', { ref: 'container', style: `height:${VIEWPORT}px` }, items)
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        const api = usePaginatedScroll(container, {
          source,
          getKey: (id: number) => id,
          onBeforePaginate: async dir => {
            // Forward never fetches — any forward growth below can only come
            // from revealing already-fetched buffered overflow, the same as
            // the fast-scroll re-arm test above.
            if (dir !== 'backward') return
            const first = source.value[0]!
            const start = Math.max(0, first - 30)
            if (start === first) {
              canOlder.value = false
              return
            }
            source.value = [...ALL_IDS.slice(start, first), ...source.value]
            canOlder.value = start > 0
          },
          hasMore: dir => (dir === 'backward' ? canOlder.value : false),
          targetHeight: TARGET_MULTIPLE,
          buffer: 0.3,
          triggerDistance: 0.5,
          maxItems: 250,
          initialEdge: 'forward',
          debug: true,
        })
        return { container, ...api }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayoutStub(container, scrollTopRef)
    await nextTick()
    await new Promise(r => setTimeout(r, 300)) // waitForStableViewport + bootstrap fill

    // Phase 1: build deep backward history, same as the fast-scroll re-arm
    // test — this leaves a large gap of already-fetched-but-unrendered
    // content sitting past the window's current forward/bottom edge.
    for (let round = 0; round < 8; round++) {
      scrollTopRef.value = 0
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 200))
      scrollTopRef.value = 700
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 60))
    }
    const startAfterBuildup = wrapper.vm.window[0]!
    expect(startAfterBuildup).toBeLessThan(LIVE_EDGE - SEED + 1) // real backward depth was fetched

    // Phase 2: continuously push toward the bottom for ~3s of wall-clock
    // scroll input, re-targeting the true bottom every ~20ms. Each forward
    // reveal trims the top edge, and restoreAnchor corrects scrollTop
    // *downward* to absorb that — a self-inflicted write that, before the
    // fix, could get sampled by onScrollFrame as the user scrolling
    // backward, flipping scrollDir and direction-gating forward shut even
    // though the push never stopped.
    const start = Date.now()
    while (Date.now() - start < 3000) {
      scrollTopRef.value = Math.max(0, container.scrollHeight - container.clientHeight)
      container.dispatchEvent(new Event('scroll'))
      await new Promise(r => setTimeout(r, 20))
    }

    expect(wrapper.vm.isAtLiveEdge).toBe(true)
    expect(wrapper.vm.window.at(-1)).toBe(LIVE_EDGE)
  }, 20000)
})

describe('usePaginatedScroll — scroll-trigger self-chaining', () => {
  it('keeps fetching after a single scroll-into-zone event until enough runway exists, when one fetch page is not enough', async () => {
    const LIVE_EDGE = 5999
    const SEED = 40
    const ALL_IDS = Array.from({ length: LIVE_EDGE + 1 }, (_, i) => i)

    const source = shallowRef(ALL_IDS.slice(LIVE_EDGE - SEED + 1, LIVE_EDGE + 1))
    const canOlder = ref(true)
    const scrollTopRef = { value: 0 }
    let backwardFetchCount = 0

    const Comp = defineComponent({
      render() {
        // Fixed small height (not the shared heightFor, which occasionally
        // assigns a 200-380px block): the point of this test is that ONE
        // fetch page is much smaller than the required runway, which only
        // holds if every item's contribution is small and predictable.
        const items: VNode[] = this.window.map((id: number) =>
          withDirectives(h('div', { key: id, 'data-h': 40 }), [[this.vItem, id]]),
        )
        return h('div', { ref: 'container', style: `height:${VIEWPORT}px` }, items)
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        const api = usePaginatedScroll(container, {
          source,
          getKey: (id: number) => id,
          onBeforePaginate: async dir => {
            if (dir !== 'backward') return
            backwardFetchCount++
            // A single deliberately tiny page (2 items, ~48px each) — far
            // less than the buffer+trigger runway usePaginatedScroll wants
            // before it's satisfied. A one-shot pagination call cannot
            // possibly build enough runway from a page this small; only a
            // self-chaining fetch loop can.
            const first = source.value[0]!
            const start = Math.max(0, first - 2)
            if (start === first) {
              canOlder.value = false
              return
            }
            source.value = [...ALL_IDS.slice(start, first), ...source.value]
            canOlder.value = start > 0
          },
          hasMore: dir => (dir === 'backward' ? canOlder.value : false),
          targetHeight: TARGET_MULTIPLE,
          buffer: 0.3,
          triggerDistance: 0.5,
          maxItems: 250,
          initialEdge: 'forward',
        })
        return { container, ...api }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayoutStub(container, scrollTopRef)
    await nextTick()
    await new Promise(r => setTimeout(r, 300)) // bootstrap fill

    backwardFetchCount = 0

    // Seed lastScrollTop at the bootstrap-pinned (live-edge) position: bootstrap
    // pins scrollTop via direct property assignment, which doesn't dispatch a
    // 'scroll' event, so the hook's internal lastScrollTop is still its initial
    // 0 until the first real event. Without this, our jump straight to 50 below
    // would read as scrollTop increasing (0 -> 50) and misdetect the direction
    // as forward instead of backward.
    container.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 30)) // let the coalesced scroll frame actually run

    // A single scroll event into the trigger zone — no further scroll input
    // at all. Before the fix, one fetch's worth of runway (~96px) was nowhere
    // near enough to clear the re-arm latch's hysteresis threshold, so the
    // trigger would fire exactly once and then wait forever for a scroll
    // event that would never come (scrollTop was already pinned near the
    // zone). After the fix, the scroll-triggered fetch chains internally
    // (fillToTarget) until real runway exists or history is exhausted.
    scrollTopRef.value = 50
    container.dispatchEvent(new Event('scroll'))

    await new Promise(r => setTimeout(r, 2000))

    expect(backwardFetchCount).toBeGreaterThan(3)
  })
})
