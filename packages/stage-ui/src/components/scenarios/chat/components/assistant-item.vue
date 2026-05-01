<script setup lang="ts">
import type { ChatAssistantMessage, ChatHistoryItem, ChatSlices, ChatSlicesText, ChatSlicesToolCallResult } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { TransitionVertical } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'

import ChatResponsePart from './response-part.vue'
import ChatToolCallBlock from './tool-call-block.vue'

import { MarkdownRenderer } from '../../../markdown'
import { getChatHistoryItemCopyText } from '../utils'
import { ChatActionMenu } from './action-menu'
import { createToolCallResultLookup, resolveToolCallBlockState } from './tool-call-results'

const props = withDefaults(defineProps<{
  message: ChatAssistantMessage
  label: string
  showPlaceholder?: boolean
  variant?: 'desktop' | 'mobile'
  toolCallRenderers?: ChatToolCallRendererRegistry
}>(), {
  showPlaceholder: false,
  variant: 'desktop',
  toolCallRenderers: () => ({}),
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'delete'): void
}>()

const resolvedSlices = computed<ChatSlices[]>(() => {
  if (props.message.slices?.length) {
    return props.message.slices
  }

  if (typeof props.message.content === 'string' && props.message.content.trim()) {
    return [{ type: 'text', text: props.message.content } satisfies ChatSlicesText]
  }

  if (Array.isArray(props.message.content)) {
    const textPart = props.message.content.find(part => 'type' in part && part.type === 'text') as { text?: string } | undefined
    if (textPart?.text)
      return [{ type: 'text', text: textPart.text } satisfies ChatSlicesText]
  }

  return []
})

const toolResultById = computed(() => {
  return createToolCallResultLookup(resolvedSlices.value, props.message.tool_results)
})

function getToolCallResult(slice: ChatSlices): ChatSlicesToolCallResult | undefined {
  if (slice.type !== 'tool-call') {
    return undefined
  }

  return toolResultById.value.get(slice.toolCall.toolCallId)
}

function getToolCallState(slice: ChatSlices): 'streaming' | 'executing' | 'done' | 'error' {
  if (slice.type === 'tool-call' && slice.streaming === true)
    return 'streaming'
  return resolveToolCallBlockState(getToolCallResult(slice))
}

function getToolCallRenderer(slice: ChatSlices) {
  if (slice.type !== 'tool-call') {
    return ChatToolCallBlock
  }

  return props.toolCallRenderers[slice.toolCall.toolName] ?? ChatToolCallBlock
}

const reasoningText = computed(() => props.message.reasoning?.trim() ?? '')
const hasReasoning = computed(() => reasoningText.value.length > 0)

// NOTICE:
// Approximate token count for the reasoning block. We don't ship a tokenizer
// in this UI package, so we use the widely-cited ~4 chars/token heuristic
// (English-leaning; underestimates code/CJK, overestimates whitespace-heavy
// text). The `~` prefix in the label signals to the user that this is an
// estimate, not a tokenizer-exact count.
// Source: OpenAI tokenizer docs and Anthropic guidance on rough token sizing.
// Removal condition: replace with a real tokenizer (e.g. `gpt-tokenizer` or
// `@anthropic-ai/tokenizer`) if/when one is added as a dependency.
const reasoningTokenEstimate = computed(() => Math.ceil(reasoningText.value.length / 4))

// Persist the user's last thinking-block expand/collapse choice so the next
// reasoning block defaults to that state across messages and sessions.
//
// Design note: `thinkingPreferred` is the shared "default for new blocks"
// in localStorage. `localOverride` is this instance's explicit user choice
// (null = "no choice yet, follow the preference"). `thinkingExpanded` is a
// writable computed: read returns the override if set, else the preference;
// write updates both. This shape is deliberately remount-tolerant: during
// streaming the parent v-for may re-key/remount the message, which would
// reset `localOverride` to null — but because the previous toggle also
// wrote the preference, the new mount still reflects the user's last
// intent instead of snapping back to false.
const thinkingPreferred = useLocalStorage<boolean>('chat/thinking-block-expanded', false)
const localOverride = ref<boolean | null>(null)
const thinkingExpanded = computed<boolean>({
  get: () => localOverride.value ?? !!thinkingPreferred.value,
  set: (value) => {
    localOverride.value = value
    thinkingPreferred.value = value
  },
})

const showLoader = computed(() => props.showPlaceholder && resolvedSlices.value.length === 0)
const containerClass = computed(() => props.variant === 'mobile' ? 'mr-0' : 'mr-12')
const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-primary-50/90 dark:bg-primary-950/90' : 'px-3 py-3 bg-primary-50/80 dark:bg-primary-950/80',
])
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
</script>

<template>
  <div flex :class="containerClass" class="ph-no-capture">
    <ChatActionMenu
      :copy-text="copyText"
      :can-delete="!showPlaceholder"
      @copy="emit('copy')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          flex="~ col" shadow="sm primary-200/50 dark:none"
          min-w-20 gap-2 rounded-xl h="unset <sm:fit"
          :class="[
            boxClasses,
            (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
          ]"
        >
          <ChatResponsePart
            v-if="message.categorization"
            :message="message"
            :variant="variant"
          />
          <div class="<sm:hidden">
            <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
          </div>
          <div
            v-if="hasReasoning"
            :class="[
              'mb-2 rounded-lg px-2 pb-2 pt-2',
              'bg-neutral-100/60 dark:bg-neutral-800/60',
              'flex flex-col gap-2 items-stretch',
              // Constrain to the assistant bubble width — `min-w-0` lets the
              // monospace content shrink below its intrinsic width so long
              // reasoning lines wrap instead of pushing the chat horizontally.
              'min-w-0 w-full max-w-full overflow-hidden',
            ]"
          >
            <button
              :class="['w-full text-start text-xs text-neutral-500 dark:text-neutral-400']"
              @click="thinkingExpanded = !thinkingExpanded"
            >
              <div i-ph:brain-duotone class="mr-1 inline-block translate-y-0.5 op-70" />
              <span class="font-medium tracking-wide uppercase">thinking</span>
              <span class="ml-1 op-60">(~{{ reasoningTokenEstimate }} tokens)</span>
            </button>
            <TransitionVertical>
              <div
                v-if="thinkingExpanded"
                :class="[
                  'rounded-md p-2 w-full max-w-full min-w-0',
                  'bg-white/70 text-xs text-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300',
                  // `break-all` is intentionally aggressive: reasoning content
                  // often contains long unbroken identifiers / URLs that
                  // `break-words` won't wrap, causing horizontal overflow.
                  'whitespace-pre-wrap break-all font-mono',
                ]"
              >
                {{ reasoningText }}
              </div>
            </TransitionVertical>
          </div>
          <div v-if="resolvedSlices.length > 0" class="flex flex-col gap-2 break-words" text="primary-700 dark:primary-100">
            <template v-for="(slice, sliceIndex) in resolvedSlices" :key="sliceIndex">
              <component
                :is="getToolCallRenderer(slice)"
                v-if="slice.type === 'tool-call'"
                :tool-name="slice.toolCall.toolName"
                :args="slice.toolCall.args"
                :streaming="slice.streaming === true"
                :state="getToolCallState(slice)"
                :result="getToolCallResult(slice)?.result"
              />
              <!-- `tool-call-result` slices are merged into their matching
                   `tool-call` block above, so render nothing on their own. -->
              <template v-else-if="slice.type === 'tool-call-result'" />
              <template v-else-if="slice.type === 'text'">
                <MarkdownRenderer :content="slice.text" />
              </template>
            </template>
          </div>
          <div v-else-if="showLoader" i-eos-icons:three-dots-loading />
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>
