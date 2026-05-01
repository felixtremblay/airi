<script setup lang="ts">
/**
 * Amazing work by Derek Morash on CSS line-clamp animation.
 *
 * https://derekmorash.com/writing/css-line-clamp-animation/
 */

import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue'

defineOptions({
  name: 'Truncatable',
})

const props = withDefaults(defineProps<TruncatableProps>(), {
  lineClamp: 3,
})

/**
 * Props for a text/content container that can be line-clamped and expanded.
 */
interface TruncatableProps {
  /**
   * Maximum visible lines while collapsed.
   *
   * @default 3
   */
  lineClamp?: number
}

const contentRef = useTemplateRef<HTMLElement>('content')

/**
 * Matches the CSS max-height transition so closing can finish before line-clamp
 * is restored to the inner content.
 */
const transitionDurationMs = 300

const expanded = shallowRef(false)
const lineClamped = shallowRef(true)
const closedHeight = shallowRef(0)
const openedHeight = shallowRef(0)
const isOverflowing = shallowRef(false)
const closeClampTimer = shallowRef<number>()

const normalizedLineClamp = computed(() => Math.max(1, Math.floor(props.lineClamp)))
const visibleHeight = computed(() => expanded.value ? openedHeight.value : closedHeight.value)
const contentStyle = computed(() => ({
  '--truncatable-line-clamp': String(normalizedLineClamp.value),
  '--truncatable-transition-duration': `${transitionDurationMs}ms`,
  'maxHeight': visibleHeight.value > 0 ? `${visibleHeight.value}px` : undefined,
}))
const containerRole = computed(() => isOverflowing.value ? 'button' : undefined)
const containerTabindex = computed(() => isOverflowing.value ? 0 : undefined)

// Compute from line-height; mutating inline -webkit-line-clamp to measure
// forces a synchronous reflow per ResizeObserver tick during streamed content.
function measureClampedHeight(element: HTMLElement) {
  const styles = getComputedStyle(element)

  const lineHeight = Number.parseFloat(styles.lineHeight)
  if (Number.isFinite(lineHeight) && lineHeight > 0)
    return lineHeight * normalizedLineClamp.value

  // Fallback for `line-height: normal`, which parses to NaN. CSS spec hints at
  // ~1.2x font-size as a reasonable default when normal is unresolved.
  const fontSize = Number.parseFloat(styles.fontSize) || 16
  return fontSize * 1.2 * normalizedLineClamp.value
}

async function measureHeights() {
  await nextTick()

  const element = contentRef.value
  if (!element)
    return

  const nextClosedHeight = measureClampedHeight(element)
  const nextOpenedHeight = element.scrollHeight

  // Skip transient mid-patch readings; would otherwise reset expansion below.
  if (nextOpenedHeight === 0)
    return

  closedHeight.value = nextClosedHeight
  openedHeight.value = nextOpenedHeight
  isOverflowing.value = nextOpenedHeight > nextClosedHeight + 1

  // Auto-correct only when the user has not chosen to expand.
  if (!isOverflowing.value && !expanded.value)
    lineClamped.value = true
}

function toggleExpanded() {
  if (!isOverflowing.value)
    return

  if (closeClampTimer.value != null)
    window.clearTimeout(closeClampTimer.value)

  if (expanded.value) {
    expanded.value = false
    closeClampTimer.value = window.setTimeout(() => {
      lineClamped.value = true
      closeClampTimer.value = undefined
    }, transitionDurationMs)
    return
  }

  lineClamped.value = false
  expanded.value = true
}

function handleContainerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ')
    return

  event.preventDefault()
  toggleExpanded()
}

// Manual tap on pointerdown/up; Chromium and WebKit drop `click` when the
// press-target is detached mid-press (DOM replaced under cursor during
// streamed content). Movement check separates tap from drag-to-select.
const TAP_MOVEMENT_THRESHOLD_PX = 5
let pointerDownPos: { x: number, y: number } | null = null

function onPointerDown(event: PointerEvent) {
  // Only capture primary-button presses; ignore right-click, middle-click, etc.
  if (event.button !== 0)
    return
  pointerDownPos = { x: event.clientX, y: event.clientY }
}

function onPointerUp(event: PointerEvent) {
  const start = pointerDownPos
  pointerDownPos = null
  if (!start)
    return

  const dx = Math.abs(event.clientX - start.x)
  const dy = Math.abs(event.clientY - start.y)
  if (dx > TAP_MOVEMENT_THRESHOLD_PX || dy > TAP_MOVEMENT_THRESHOLD_PX)
    return // user dragged (likely text selection), not a tap

  toggleExpanded()
}

function onPointerCancel() {
  pointerDownPos = null
}

onMounted(measureHeights)
onBeforeUnmount(() => {
  if (closeClampTimer.value != null)
    window.clearTimeout(closeClampTimer.value)
})
useResizeObserver(contentRef, measureHeights)
</script>

<template>
  <div
    class="truncatable"
    :class="{ 'truncatable--interactive': isOverflowing }"
    :style="contentStyle"
    :role="containerRole"
    :tabindex="containerTabindex"
    :aria-expanded="isOverflowing ? expanded : undefined"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @keydown="handleContainerKeydown"
  >
    <div
      ref="content"
      class="truncatable__inner"
      :class="{ 'truncatable__inner--line-clamped': lineClamped }"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.truncatable {
  width: 100%;
  overflow: hidden;
  transition: max-height var(--truncatable-transition-duration) ease;
}

.truncatable--interactive {
  cursor: pointer;
}

.truncatable:focus-visible {
  outline: 2px solid currentcolor;
  outline-offset: 2px;
}

.truncatable__inner--line-clamped {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--truncatable-line-clamp);
}
</style>
