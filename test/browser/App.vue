<script setup lang="ts">
import { nextTick, onMounted, ref, shallowRef } from 'vue'

import type { PaginatedScrollState } from '../../src/types'

import { usePaginatedScroll } from '../../src/usePaginatedScroll'

const container = ref<HTMLElement | null>(null)
const source = shallowRef<number[]>([])
const canOlder = ref(false)
const showSkeleton = ref(true)
const fetches = ref(0)
const heights = ref(new Map<number, number>())
const lifecycleStatus = ref<'busy' | 'idle'>('idle')
const savedKey = ref<number | null>(null)
let savedState: PaginatedScrollState | null = null

const api = usePaginatedScroll(container, {
  buffer: 0.5,
  followTail: true,
  getKey: id => id,
  hasMore: direction => direction === 'backward' && canOlder.value,
  maxItems: 120,
  onBeforePaginate: async direction => {
    if (direction !== 'backward') return
    fetches.value++
    await new Promise(resolve => setTimeout(resolve, 80))
    const first = source.value[0]!
    const last = source.value.at(-1)!
    source.value = [
      ...Array.from({ length: 40 }, (_, index) => first - 40 + index),
      ...source.value,
      ...Array.from({ length: 20 }, (_, index) => last + index + 1),
    ]
    showSkeleton.value = false
  },
  source,
  targetHeight: 3,
  triggerDistance: 0.5,
})
const { vItem, window: paginationWindow } = api

function save() {
  savedState = api.captureState()
  savedKey.value = (savedState?.anchorKey as number | undefined) ?? null
}

async function restore() {
  if (!savedState) return
  lifecycleStatus.value = 'busy'
  try {
    await api.restoreState(savedState)
  } finally {
    lifecycleStatus.value = 'idle'
  }
}

async function reset() {
  lifecycleStatus.value = 'busy'
  try {
    await api.reset()
  } finally {
    lifecycleStatus.value = 'idle'
  }
}

function resizeAboveAnchor() {
  const state = api.captureState()
  if (!state) return
  const anchorIndex = paginationWindow.value.findIndex(id => id === state.anchorKey)
  const target = paginationWindow.value[Math.max(0, anchorIndex - 1)]
  if (target === undefined) return
  heights.value = new Map(heights.value).set(target, (heights.value.get(target) ?? 40) + 80)
}

onMounted(async () => {
  await new Promise(resolve => setTimeout(resolve, 80))
  source.value = Array.from({ length: 30 }, (_, index) => index + 100)
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 250))
  canOlder.value = true
})
</script>

<template>
  <div class="controls">
    <button data-testid="save" @click="save">save</button>
    <button data-testid="reset" @click="reset">reset</button>
    <button data-testid="restore" @click="restore">restore</button>
    <button data-testid="resize" @click="resizeAboveAnchor">resize</button>
    <output data-testid="fetches">{{ fetches }}</output>
    <output data-testid="lifecycle-status">{{ lifecycleStatus }}</output>
    <output data-testid="saved-key">{{ savedKey }}</output>
    <output data-testid="window-start">{{ paginationWindow[0] }}</output>
    <output data-testid="window-end">{{ paginationWindow.at(-1) }}</output>
  </div>

  <div ref="container" class="scroller" data-testid="scroller">
    <div v-if="showSkeleton" class="skeleton" data-testid="skeleton" />
    <div
      v-for="id in paginationWindow"
      :key="id"
      v-item="id"
      class="row"
      :data-id="id"
      :style="{ height: `${heights.get(id) ?? 40}px` }"
    >
      {{ id }}
    </div>
    <div class="footer" data-testid="footer" />
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.controls {
  height: 40px;
}

.scroller {
  height: 400px;
  overflow-y: scroll;
  overflow-anchor: none;
}

.skeleton {
  height: 600px;
  background: #ddd;
}

.row {
  border-bottom: 1px solid #ccc;
}

.footer {
  height: 200px;
}
</style>
