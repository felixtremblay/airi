<script setup lang="ts">
import { Collapsible, ContainerError } from '@proj-airi/ui'
import { computed } from 'vue'

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
 * Renders the tool result for the expanded panel.
 *
 * Accepts both string results (most tool returns are stringified) and
 * already-parsed objects (e.g. structured MCP results). For objects,
 * pretty-prints as JSON; for strings, returns as-is.
 */
const resultDisplayText = computed<string>(() => {
  if (props.result == null)
    return ''
  if (typeof props.result === 'string')
    return props.result
  try {
    return JSON.stringify(props.result, null, 2)
  }
  catch {
    return String(props.result)
  }
})

const hasResultToShow = computed(() => {
  // image_journal already renders a richer preview from `props.result`, so
  // skip the raw text dump there to avoid double-rendering.
  if (props.toolName === 'image_journal')
    return false
  return resultDisplayText.value.trim().length > 0
})
</script>

<template>
  <Collapsible
    :class="[
      'bg-primary-100/40 dark:bg-primary-900/60 rounded-lg px-1 pb-1 pt-1',
      'flex flex-col gap-2 items-start',
    ]"
  >
    <template #trigger="{ visible, setVisible }">
      <button
        :class="[
          'w-full text-start',
          'inline-flex items-center',
        ]"
        @click="setVisible(!visible)"
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
    </template>
    <div
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
  </Collapsible>
</template>
