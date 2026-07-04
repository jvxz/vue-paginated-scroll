<script setup lang="ts">
import { computed, ref, shallowRef, triggerRef } from 'vue'

import type { Message } from './data'

import { usePaginatedScroll, PaginatedScrollDebug } from '../src/index'
import { FakeTimeline } from './data'

const timeline = new FakeTimeline(5000, 160)
const container = ref<HTMLElement | null>(null)

// The consumer-owned source. shallowRef + manual trigger to mimic large arrays.
const events = shallowRef<Message[]>([])

const firstId = computed(() => events.value[0]?.id ?? timeline.liveEdgeId)
const lastId = computed(() => events.value.at(-1)?.id ?? timeline.oldestId)

// Reactive exhaustion, developer-declared from the "SDK".
const canOlder = ref(true)
const canNewer = ref(false)

const targetHeight = ref(6)
const followTail = ref(true)
const debug = ref(true)

const { window, vItem, isAtLiveEdge, isPaginating, scrollToEdge, debugState } = usePaginatedScroll(container, {
  buffer: 0.3,
  debug,
  followTail,
  getKey: e => e.id,
  hasMore: direction => (direction === 'backward' ? canOlder : canNewer),
  initialEdge: 'forward',
  maxItems: 600,
  onBeforePaginate: async direction => {
    if (direction === 'backward') {
      const page = await timeline.older(firstId.value)
      if (page.length) {
        events.value = [...page, ...events.value]
        triggerRef(events)
      }
      canOlder.value = timeline.canGoOlder(page[0]?.id ?? firstId.value)
    } else {
      const page = await timeline.newer(lastId.value)
      if (page.length) {
        events.value = [...events.value, ...page]
        triggerRef(events)
      }
      canNewer.value = timeline.canGoNewer(page[page.length - 1]?.id ?? lastId.value)
    }
  },
  slowPaginationMs: 40,
  source: events,
  targetHeight,
  triggerDistance: 0.5,
})

async function boot() {
  events.value = await timeline.initial(40)
  triggerRef(events)
  canOlder.value = timeline.canGoOlder(events.value[0]?.id ?? 0)
  canNewer.value = false
}
void boot()

// Simulate a new live message arriving on its own.
function pushLive() {
  const msg = timeline.emitLive()
  events.value = [...events.value, msg]
  triggerRef(events)
  // If the user is scrolled up, there's now newer history to fetch.
  if (!isAtLiveEdge.value) canNewer.value = true
}
</script>

<template>
  <div class="app">
    <header>
      <h1>vue-paginated-scroll · playground</h1>
      <div class="controls">
        <label
          >target×<input v-model.number="targetHeight" type="range" min="1.5" max="6" step="0.5" />{{
            targetHeight
          }}</label
        >
        <label><input v-model="followTail" type="checkbox" /> followTail</label>
        <label><input v-model="debug" type="checkbox" /> debug</label>
        <button @click="pushLive">+ live message</button>
        <button @click="scrollToEdge('forward')">jump to latest ↓</button>
        <button @click="scrollToEdge('backward')">jump to start ↑</button>
      </div>
      <div class="status">
        window: {{ window.length }} rows · ids {{ window[0]?.id ?? '—' }}–{{ window[window.length - 1]?.id ?? '—' }} ·
        liveEdge: {{ isAtLiveEdge ? 'yes' : 'no' }} · paginating: {{ isPaginating.backward ? '↑' : ''
        }}{{ isPaginating.forward ? '↓' : '' }}{{ !isPaginating.backward && !isPaginating.forward ? 'idle' : '' }}
      </div>
    </header>

    <div ref="container" class="timeline">
      <article v-for="event in window" :key="event.id" v-item="event.id" class="msg" :class="'msg--' + event.kind">
        <div class="msg__meta">#{{ event.id }} · {{ event.author }} · {{ event.kind }}</div>
        <div class="msg__text">{{ event.text }}</div>
        <div v-if="event.blockHeight" class="msg__block" :style="{ height: event.blockHeight + 'px' }">
          {{ event.kind === 'rules' ? '📜 rules block' : '🖼 image' }} · {{ event.blockHeight }}px
        </div>
      </article>

      <PaginatedScrollDebug :state="debugState" />
    </div>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #0f172a;
  color: #e2e8f0;
}
html,
body {
  height: 100%;
}
/* min-height floors keep the layout sane even where 100vh resolves to 0
   (e.g. some headless/preview viewports report innerHeight 0). */
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 760px;
}
header {
  padding: 10px 16px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
}
h1 {
  font-size: 14px;
  margin: 0 0 8px;
  font-weight: 600;
}
.controls {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
}
.controls label {
  display: flex;
  gap: 4px;
  align-items: center;
}
.controls button {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid #475569;
  background: #334155;
  color: #e2e8f0;
  cursor: pointer;
}
.controls button:hover {
  background: #475569;
}
.status {
  margin-top: 6px;
  font-size: 11px;
  color: #94a3b8;
  font-family: ui-monospace, monospace;
}
.timeline {
  position: relative;
  flex: 1;
  min-height: 600px;
  overflow-y: auto;
  padding: 12px;
}
.msg {
  padding: 8px 12px;
  margin: 6px 0;
  border-radius: 8px;
  background: #1e293b;
  border: 1px solid #263449;
}
.msg--image {
  border-color: #3b4d66;
}
.msg--rules {
  border-color: #5b4a2f;
  background: #241f16;
}
.msg__meta {
  font-size: 10px;
  color: #64748b;
  font-family: ui-monospace, monospace;
  margin-bottom: 4px;
}
.msg__text {
  font-size: 13px;
  line-height: 1.45;
}
.msg__block {
  margin-top: 8px;
  border-radius: 6px;
  background: #0b1220;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  font-size: 12px;
  border: 1px dashed #334155;
}
</style>
