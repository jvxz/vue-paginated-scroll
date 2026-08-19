import type { VNode } from 'vue'

import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef, withDirectives } from 'vue'

import { usePaginatedScroll } from '../src/usePaginatedScroll'

const VIEWPORT = 400

function installLayout(container: HTMLElement, scrollTopRef: { value: number }) {
  Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => VIEWPORT })
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => scrollTopRef.value,
    set: value => {
      const max = Math.max(0, container.scrollHeight - VIEWPORT)
      scrollTopRef.value = Math.max(0, Math.min(value, max))
      container.dispatchEvent(new Event('scroll'))
    },
  })
  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: () =>
      [...container.children].reduce((total, child) => total + Number((child as HTMLElement).dataset.h ?? 0), 0),
  })

  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this === container) return rect(0, VIEWPORT)
    if (this.parentElement !== container) return rect(0, 0)

    let top = -scrollTopRef.value
    for (const child of container.children) {
      if (child === this) break
      top += Number((child as HTMLElement).dataset.h ?? 0)
    }
    return rect(top, Number(this.dataset.h ?? 0))
  }
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    toJSON() {},
    top,
    width: 0,
    x: 0,
    y: top,
  } as DOMRect
}

async function settle(ms = 250) {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, ms))
  await nextTick()
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  readonly callback: ResizeObserverCallback
  readonly targets = new Set<Element>()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }

  disconnect() {}
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }

  resize(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  MockResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('usePaginatedScroll — consumer chrome and transaction anchoring', () => {
  it('triggers from the first item edge instead of waiting to reach the top of a tall loading skeleton', async () => {
    const source = shallowRef(Array.from({ length: 20 }, (_, id) => id + 100))
    const canOlder = ref(false)
    const scrollTopRef = { value: 0 }
    let fetches = 0

    const Comp = defineComponent({
      render() {
        const rows: VNode[] = this.window.map((id: number) =>
          withDirectives(h('div', { 'data-h': 40, 'data-id': id, key: id }), [[this.vItem, id]]),
        )
        return h('div', { ref: 'container' }, [h('div', { 'data-h': 600, 'data-testid': 'skeleton' }), ...rows])
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        const api = usePaginatedScroll(container, {
          buffer: 0.5,
          getKey: (id: number) => id,
          hasMore: direction => direction === 'backward' && canOlder.value,
          maxItems: 120,
          onBeforePaginate: direction => {
            if (direction !== 'backward') return
            fetches++
            const first = source.value[0]!
            source.value = [...Array.from({ length: 8 }, (_, index) => first - 8 + index), ...source.value]
          },
          source,
          targetHeight: 3,
          triggerDistance: 0.5,
        })
        return { container, ...api }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayout(container, scrollTopRef)
    await settle()

    canOlder.value = true
    container.dispatchEvent(new Event('scroll'))
    await settle(30)

    // The viewport is 180px inside the item window's backward edge, but still
    // 780px from the container's physical top because of the skeleton.
    scrollTopRef.value = 780
    container.dispatchEvent(new Event('scroll'))
    await settle()

    expect(fetches).toBe(1)
  })

  it('anchors before a slow fetch so removing edge chrome cannot move the visible event', async () => {
    const source = shallowRef(Array.from({ length: 24 }, (_, id) => id + 100))
    const showSkeleton = ref(true)
    const canOlder = ref(false)
    const scrollTopRef = { value: 0 }
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>(resolve => (releaseFetch = resolve))

    const Comp = defineComponent({
      render() {
        const rows: VNode[] = this.window.map((id: number) =>
          withDirectives(h('div', { 'data-h': 40, 'data-id': id, key: id }), [[this.vItem, id]]),
        )
        return h('div', { ref: 'container' }, [
          this.showSkeleton ? h('div', { 'data-h': 300, 'data-testid': 'skeleton' }) : null,
          ...rows,
        ])
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        const api = usePaginatedScroll(container, {
          buffer: 0.5,
          getKey: (id: number) => id,
          hasMore: direction => direction === 'backward' && canOlder.value,
          maxItems: 120,
          onBeforePaginate: async direction => {
            if (direction !== 'backward') return
            await fetchGate
            const first = source.value[0]!
            source.value = [...Array.from({ length: 10 }, (_, index) => first - 10 + index), ...source.value]
            showSkeleton.value = false
          },
          source,
          targetHeight: 3,
          triggerDistance: 0.5,
        })
        return { container, showSkeleton, ...api }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayout(container, scrollTopRef)
    await settle()

    canOlder.value = true
    container.dispatchEvent(new Event('scroll'))
    await settle(30)
    scrollTopRef.value = 420
    container.dispatchEvent(new Event('scroll'))
    await settle(40)

    const anchor = container.querySelector<HTMLElement>('[data-id="104"]')!
    const before = anchor.getBoundingClientRect().top

    releaseFetch()
    await settle(400)

    expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1)
  })
})

describe('usePaginatedScroll — public state lifecycle', () => {
  it('captures and restores the same item at the same viewport offset', async () => {
    const source = shallowRef(Array.from({ length: 80 }, (_, id) => id))
    const scrollTopRef = { value: 0 }

    const Comp = defineComponent({
      render() {
        return h(
          'div',
          { ref: 'container' },
          this.window.map((id: number) =>
            withDirectives(h('div', { 'data-h': 40, 'data-id': id, key: id }), [[this.vItem, id]]),
          ),
        )
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        return {
          container,
          ...usePaginatedScroll(container, {
            getKey: (id: number) => id,
            hasMore: () => false,
            maxItems: 120,
            onBeforePaginate: () => {},
            source,
            targetHeight: 3,
          }),
        }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayout(container, scrollTopRef)
    await settle()

    scrollTopRef.value = 600
    container.dispatchEvent(new Event('scroll'))
    await settle(30)
    const state = wrapper.vm.captureState()
    expect(state).not.toBeNull()
    const anchor = container.querySelector<HTMLElement>(`[data-id="${state!.anchorKey}"]`)!
    const offset = anchor.getBoundingClientRect().top

    const resetting = wrapper.vm.reset()
    expect(wrapper.vm.window).toEqual([])
    await resetting
    expect(scrollTopRef.value).toBe(container.scrollHeight - container.clientHeight)

    await wrapper.vm.restoreState(state!)
    const restored = container.querySelector<HTMLElement>(`[data-id="${state!.anchorKey}"]`)!
    expect(Math.abs(restored.getBoundingClientRect().top - offset)).toBeLessThanOrEqual(1)
  })

  it('falls back to the current live edge when a saved anchor is stale', async () => {
    const source = shallowRef(Array.from({ length: 50 }, (_, id) => id))
    const scrollTopRef = { value: 0 }
    const Comp = defineComponent({
      render() {
        return h(
          'div',
          { ref: 'container' },
          this.window.map((id: number) =>
            withDirectives(h('div', { 'data-h': 40, 'data-id': id, key: id }), [[this.vItem, id]]),
          ),
        )
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        return {
          container,
          ...usePaginatedScroll(container, {
            getKey: (id: number) => id,
            hasMore: () => false,
            onBeforePaginate: () => {},
            source,
            targetHeight: 3,
          }),
        }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayout(container, scrollTopRef)
    await settle()
    scrollTopRef.value = 200
    container.dispatchEvent(new Event('scroll'))
    await settle(30)
    const state = wrapper.vm.captureState()!

    source.value = Array.from({ length: 30 }, (_, id) => id + 1000)
    const restored = await wrapper.vm.restoreState(state)

    expect(restored).toBe(false)
    expect(wrapper.vm.window.at(-1)).toBe(1029)
    expect(scrollTopRef.value).toBe(container.scrollHeight - container.clientHeight)
  })

  it('invalidates an old pagination continuation when reset switches sources', async () => {
    const source = shallowRef(Array.from({ length: 30 }, (_, id) => id + 100))
    const canOlder = ref(false)
    const scrollTopRef = { value: 0 }
    let releaseFetch!: () => void
    const fetchGate = new Promise<void>(resolve => (releaseFetch = resolve))

    const Comp = defineComponent({
      render() {
        return h(
          'div',
          { ref: 'container' },
          this.window.map((id: number) =>
            withDirectives(h('div', { 'data-h': 40, 'data-id': id, key: id }), [[this.vItem, id]]),
          ),
        )
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        return {
          container,
          ...usePaginatedScroll(container, {
            getKey: (id: number) => id,
            hasMore: direction => direction === 'backward' && canOlder.value,
            onBeforePaginate: async () => fetchGate,
            source,
            targetHeight: 3,
          }),
        }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayout(container, scrollTopRef)
    await settle()
    canOlder.value = true
    container.dispatchEvent(new Event('scroll'))
    await settle(30)
    scrollTopRef.value = 0
    container.dispatchEvent(new Event('scroll'))
    await settle(40)

    source.value = Array.from({ length: 30 }, (_, id) => id + 1000)
    canOlder.value = false
    await wrapper.vm.reset()
    expect(container.style.overflowAnchor).toBe('')
    releaseFetch()
    await settle(300)

    expect(wrapper.vm.window.every((id: number) => id >= 1000)).toBe(true)
    expect(wrapper.vm.window.at(-1)).toBe(1029)
  })
})

describe('usePaginatedScroll — reflow and landing invariants', () => {
  it('compensates a registered row resize above the active anchor', async () => {
    const source = shallowRef(Array.from({ length: 100 }, (_, id) => id))
    const scrollTopRef = { value: 0 }
    const Comp = defineComponent({
      render() {
        return h(
          'div',
          { ref: 'container' },
          this.window.map((id: number) =>
            withDirectives(h('div', { 'data-h': 40, 'data-id': id, key: id }), [[this.vItem, id]]),
          ),
        )
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        return {
          container,
          ...usePaginatedScroll(container, {
            getKey: (id: number) => id,
            hasMore: () => false,
            onBeforePaginate: () => {},
            source,
            targetHeight: 3,
          }),
        }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayout(container, scrollTopRef)
    await settle()
    scrollTopRef.value = Math.max(0, container.scrollHeight - VIEWPORT - 300)
    container.dispatchEvent(new Event('scroll'))
    await settle(40)

    const state = wrapper.vm.captureState()!
    const anchor = container.querySelector<HTMLElement>(`[data-id="${state.anchorKey}"]`)!
    const rowAbove = container.querySelector<HTMLElement>(`[data-id="${Number(state.anchorKey) - 1}"]`)!
    const before = anchor.getBoundingClientRect().top
    rowAbove.dataset.h = '80'
    MockResizeObserver.instances.find(observer => observer.targets.has(rowAbove))!.resize(rowAbove)

    expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1)
  })

  it('rotates backward and forward pagination into opposite outer-quarter landing bands', async () => {
    const source = shallowRef(Array.from({ length: 300 }, (_, id) => id))
    const scrollTopRef = { value: 0 }
    const Comp = defineComponent({
      render() {
        return h(
          'div',
          { ref: 'container' },
          this.window.map((id: number) =>
            withDirectives(h('div', { 'data-h': 40, 'data-id': id, key: id }), [[this.vItem, id]]),
          ),
        )
      },
      setup() {
        const container = ref<HTMLElement | null>(null)
        return {
          container,
          ...usePaginatedScroll(container, {
            buffer: 0.5,
            getKey: (id: number) => id,
            hasMore: () => false,
            maxItems: 120,
            onBeforePaginate: () => {},
            source,
            targetHeight: 3,
            triggerDistance: 0.5,
          }),
        }
      },
    })

    const wrapper = mount(Comp, { attachTo: document.body })
    const container = wrapper.vm.container as HTMLElement
    installLayout(container, scrollTopRef)
    await settle()
    container.dispatchEvent(new Event('scroll'))
    await settle(30)

    scrollTopRef.value = 0
    container.dispatchEvent(new Event('scroll'))
    await settle(600)
    const backwardRange = container.scrollHeight - container.clientHeight
    expect(scrollTopRef.value / backwardRange).toBeGreaterThanOrEqual(0.75)

    scrollTopRef.value = container.scrollHeight - container.clientHeight
    container.dispatchEvent(new Event('scroll'))
    await settle(600)
    const forwardRange = container.scrollHeight - container.clientHeight
    expect(scrollTopRef.value / forwardRange).toBeLessThanOrEqual(0.25)
  })
})
