<script setup lang="ts">
import { computed } from 'vue'

import type { DebugState } from './types'

const props = defineProps<{
  /** The `debugState` returned by `usePaginatedScroll`. */
  state: DebugState | null
}>()

const bandColor = (armed: boolean, reason: string): string => {
  if (armed) return 'rgba(52, 211, 153, 0.22)' // green — armed
  if (reason === 'paginating') return 'rgba(248, 113, 113, 0.28)' // red pulse — firing
  return 'rgba(148, 163, 184, 0.18)' // grey — disarmed
}

const backward = computed(() => props.state?.triggers.backward)
const forward = computed(() => props.state?.triggers.forward)
</script>

<template>
  <div v-if="state" class="pgs-debug" aria-hidden="true">
    <!-- Trigger bands, positioned at each edge, sized to triggerPx. -->
    <div
      v-if="backward"
      class="pgs-debug__band pgs-debug__band--top"
      :class="{ 'pgs-debug__band--firing': backward.disarmedReason === 'paginating' }"
      :style="{
        height: backward.triggerPx + 'px',
        background: bandColor(backward.armed, backward.disarmedReason),
      }"
    >
      <span class="pgs-debug__label">
        ▲ backward · {{ backward.armed ? 'armed' : backward.disarmedReason }} ·
        {{ Math.round(backward.distanceToEdge) }}px
      </span>
    </div>

    <div
      v-if="forward"
      class="pgs-debug__band pgs-debug__band--bottom"
      :class="{ 'pgs-debug__band--firing': forward.disarmedReason === 'paginating' }"
      :style="{
        height: forward.triggerPx + 'px',
        background: bandColor(forward.armed, forward.disarmedReason),
      }"
    >
      <span class="pgs-debug__label">
        ▼ forward · {{ forward.armed ? 'armed' : forward.disarmedReason }} · {{ Math.round(forward.distanceToEdge) }}px
      </span>
    </div>

    <!-- HUD -->
    <div class="pgs-debug__hud">
      <div>window: {{ state.windowCount }} rows · {{ state.windowHeight }}px</div>
      <div>viewport: {{ Math.round(state.viewportHeight) }}px · buffer: {{ Math.round(state.bufferPx) }}px</div>
      <div>anchor: {{ state.anchorKey ?? '—' }}</div>
      <div>live edge: {{ state.isAtLiveEdge ? 'yes' : 'no' }}</div>
      <div v-if="state.lastRenderMs != null">last render: {{ Math.round(state.lastRenderMs) }}ms</div>
    </div>
  </div>
</template>

<style scoped>
.pgs-debug {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.pgs-debug__band {
  position: absolute;
  left: 0;
  right: 0;
  border: 1px dashed rgba(100, 116, 139, 0.6);
  transition: background 120ms ease;
}
.pgs-debug__band--top {
  top: 0;
  border-top: none;
}
.pgs-debug__band--bottom {
  bottom: 0;
  border-bottom: none;
}
.pgs-debug__band--firing {
  animation: pgs-pulse 0.4s ease;
}
@keyframes pgs-pulse {
  0% {
    filter: brightness(1.6);
  }
  100% {
    filter: brightness(1);
  }
}
.pgs-debug__label {
  position: absolute;
  left: 6px;
  padding: 1px 4px;
  color: #0f172a;
  background: rgba(255, 255, 255, 0.75);
  border-radius: 3px;
  white-space: nowrap;
}
.pgs-debug__band--top .pgs-debug__label {
  top: 4px;
}
.pgs-debug__band--bottom .pgs-debug__label {
  bottom: 4px;
}
.pgs-debug__hud {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 6px 8px;
  color: #e2e8f0;
  background: rgba(15, 23, 42, 0.82);
  border-radius: 6px;
  line-height: 1.5;
}
</style>
