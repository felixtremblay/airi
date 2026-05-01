<script setup lang="ts">
import { ContainerError, TransitionVertical } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'

import { createToolResultError } from './tool-call-display'

const props = defineProps<{
  toolName: string
  args: string
  state?: 'streaming' | 'executing' | 'done' | 'error'
  /**
   * True while the model is still streaming the tool call's arguments.
   * The block renders immediately on `tool-call-streaming-start` so the
   * user can expand it and watch the args being authored, instead of
   * waiting for the final `tool-call` event.
   */
  streaming?: boolean
  result?: unknown
}>()

const resultError = computed(() => props.state === 'error' ? createToolResultError(props.result) : undefined)

const formattedArgs = computed(() => {
  try {
    const parsed = JSON.parse(props.args)
    return JSON.stringify(parsed, null, 2).trim()
  }
  catch {
    return props.args
  }
})

/**
 * Pulls text from an MCP-style content envelope.
 *
 * Before:
 * - { content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'there' }] }
 *
 * After:
 * - ['hi', 'there']
 *
 * Before:
 * - [{ type: 'text', text: 'hi' }]
 *
 * After:
 * - ['hi']
 *
 * Returns `null` when the value does not look like an MCP content envelope.
 */
function extractMcpTextParts(value: unknown): string[] | null {
  const parts = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content))
        ? (value as { content: unknown[] }).content
        : null
  if (!parts)
    return null
  const texts = parts
    .map((part) => {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
        return (part as { text: string }).text
      return ''
    })
    .filter(Boolean)
  return texts.length > 0 ? texts : null
}

/**
 * Pretty-prints the tool result for the expanded panel.
 *
 * Handles three layers in order:
 * 1. Coerce strings into parsed JSON when possible; non-JSON strings
 *    are returned as-is.
 * 2. Unwrap the MCP envelope `{ content: [{ type: 'text', text }, ...] }`
 *    by joining text parts. Arrays of text parts (xsai sometimes drops
 *    the envelope and passes the parts directly) are handled the same
 *    way.
 * 3. If the unwrapped text is itself JSON (typical for MCP servers that
 *    serialize structured results into a single text block, e.g.
 *    handy-mcp's queue/status objects), re-pretty-print it.
 */
const resultDisplayText = computed<string>(() => {
  if (props.result == null)
    return ''

  let value: unknown = props.result
  if (typeof value === 'string') {
    const original = value
    try {
      value = JSON.parse(value)
    }
    catch {
      return original
    }
  }

  const textParts = extractMcpTextParts(value)
  if (textParts != null) {
    const joined = textParts.join('\n')
    try {
      return JSON.stringify(JSON.parse(joined), null, 2)
    }
    catch {
      return joined
    }
  }

  try {
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
})

const hasResultToShow = computed(() => {
  // image_journal already renders a richer preview from `props.result`, so
  // skip the raw text dump there to avoid double-rendering.
  if (props.toolName === 'image_journal')
    return false
  return resultDisplayText.value.trim().length > 0
})

// Sticky tool-call expand state. Same pattern as the assistant-item.vue
// thinking block: `expandPreferred` is the shared "default for new blocks"
// in localStorage, `localOverride` is this instance's explicit choice
// (null = "no choice yet, follow the preference"). Toggling updates both
// so that any block which has not been individually toggled re-renders
// against the latest preference, while a block the user has personally
// toggled keeps its setting across remounts.
const expandPreferred = useLocalStorage<boolean>('chat/tool-call-block-expanded', false)
const localOverride = ref<boolean | null>(null)
const expanded = computed<boolean>({
  get: () => localOverride.value ?? !!expandPreferred.value,
  set: (value) => {
    localOverride.value = value
    expandPreferred.value = value
  },
})
</script>

<template>
  <div
    :class="[
      'bg-primary-100/40 dark:bg-primary-900/60 rounded-lg px-1 pb-1 pt-1',
      'flex flex-col gap-2 items-stretch',
    ]"
  >
    <button
      :class="[
        'w-full text-start',
        'inline-flex items-center',
      ]"
      @click="expanded = !expanded"
    >
      <div
        v-if="state === 'streaming'"
        i-svg-spinners:3-dots-fade class="mr-1 inline-block translate-y-0.5 op-60"
      />
      <div
        v-else-if="state === 'executing'"
        i-eos-icons:loading class="mr-1 inline-block translate-y-0.5 op-50"
      />
      <div
        v-else-if="state === 'error'"
        i-solar:danger-circle-bold-duotone class="mr-1 inline-block text-red-500"
      />
      <div
        v-else-if="state === 'done'"
        i-solar:check-circle-bold-duotone class="mr-1 inline-block text-emerald-500"
      />
      <div
        v-else
        i-solar:sledgehammer-bold-duotone class="mr-1 inline-block translate-y-1 op-50"
      />
      <code class="text-xs">{{ toolName }}</code>
      <span v-if="state === 'streaming'" class="ml-2 text-xs op-60">
        writing args...
      </span>
      <span v-if="state === 'error' && result" class="ml-2 text-xs text-red-500 op-80">
        ({{ result }})
      </span>
    </button>
    <TransitionVertical>
      <div
        v-if="expanded"
        :class="[
          'rounded-md p-2 w-full',
          'bg-neutral-100/80 text-sm text-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-200',
        ]"
      >
        <template v-if="resultError">
          <ContainerError
            :error="resultError"
            :include-stack="false"
            :show-feedback-button="false"
            height-preset="auto"
          />
          <div
            :class="[
              'mt-2 whitespace-pre-wrap break-words font-mono',
            ]"
          >
            {{ formattedArgs }}
          </div>
        </template>
        <div v-else class="flex flex-col gap-2">
          <div>
            <div class="mb-1 text-xs tracking-wide uppercase opacity-60">
              args
            </div>
            <div class="whitespace-pre-wrap break-words font-mono">
              {{ formattedArgs }}
            </div>
          </div>
          <div v-if="hasResultToShow">
            <div
              :class="[
                'mb-1 text-xs uppercase tracking-wide opacity-60',
                state === 'error' ? 'text-red-500 dark:text-red-400' : '',
              ]"
            >
              {{ state === 'error' ? 'error' : 'result' }}
            </div>
            <div
              :class="[
                'whitespace-pre-wrap break-words font-mono',
                state === 'error' ? 'text-red-700 dark:text-red-300' : '',
              ]"
            >
              {{ resultDisplayText }}
            </div>
          </div>
        </div>
      </div>
    </TransitionVertical>
  </div>
</template>
