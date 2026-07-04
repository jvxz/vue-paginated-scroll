import type { Directive } from 'vue'

import type { ItemKey } from './types'

/**
 * Per-composable-instance map of item key → rendered element. This is the
 * library's one reach into consumer markup (via the `v-pgs-item` directive):
 * it lets the anchor logic locate the DOM node for any windowed item, surviving
 * date dividers and other non-item children that positional mapping breaks on.
 */
export class ItemRegistry {
  private readonly map = new Map<ItemKey, HTMLElement>()

  /** Optional hook: notified as elements enter/leave, for the shared ResizeObserver. */
  onRegister?: (key: ItemKey, el: HTMLElement) => void
  onUnregister?: (key: ItemKey, el: HTMLElement) => void

  set(key: ItemKey, el: HTMLElement): void {
    this.map.set(key, el)
    this.onRegister?.(key, el)
  }

  delete(key: ItemKey): void {
    const el = this.map.get(key)
    if (el) {
      this.map.delete(key)
      this.onUnregister?.(key, el)
    }
  }

  get(key: ItemKey): HTMLElement | undefined {
    return this.map.get(key)
  }

  has(key: ItemKey): boolean {
    return this.map.has(key)
  }
}

/** Builds the `v-pgs-item` directive bound to a given registry instance. */
export function createItemDirective(registry: ItemRegistry): Directive<HTMLElement, ItemKey> {
  return {
    mounted(el, binding) {
      registry.set(binding.value, el)
    },
    unmounted(_el, binding) {
      registry.delete(binding.value)
    },
    updated(el, binding) {
      if (binding.value !== binding.oldValue) {
        if (binding.oldValue != null) registry.delete(binding.oldValue)
        registry.set(binding.value, el)
      }
    },
  }
}
