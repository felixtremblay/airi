import type { Tool, UserMessage } from '@xsai/shared-chat'

import type { ContextMessage } from '../../types/chat'

export type ContextSnapshot = Record<string, ContextMessage[]>

/**
 * Describes the minimal tool metadata worth repeating in prompt text.
 *
 * @param TName Tool name type used by the caller.
 */
export interface ToolPromptEntry<TName extends string = string> {
  /** Exact function name the model must call through native tool calling. */
  name: TName
  /** Short human-readable capability summary from the tool definition. */
  description?: string
}

function toolPromptEntryFromTool(tool: Tool): ToolPromptEntry | null {
  const candidate = tool as Tool & {
    name?: string
    description?: string
    function?: {
      name?: string
      description?: string
    }
  }

  const name = candidate.function?.name ?? candidate.name
  if (!name)
    return null

  return {
    name,
    description: candidate.function?.description ?? candidate.description,
  }
}

/**
 * Render runtime context modules into a compact, readable text block.
 *
 * Use when:
 * - Composing chat prompts that need to attach side-channel runtime context
 *   (e.g. game state, system status) to the latest user message.
 *
 * Expects:
 * - A snapshot keyed by `contextId`. Only the per-message `text` field is
 *   included; volatile metadata (random IDs, ms timestamps) is excluded so
 *   the output stays deterministic and KV-cache-friendly.
 *
 * Returns:
 * - Empty string when the snapshot is empty.
 * - Otherwise a `[Context]` block with one bullet per module, e.g.
 *   `[Context]\n- system:minecraft-integration: Bot is online ...`
 *
 * Why this shape (not XML):
 * - Weak local models (8B/14B) tend to mirror conspicuous structured
 *   wrappers (`<context>...</context>`) back into their replies, treating
 *   them as data to be quoted. A flat bullet list looks like ordinary
 *   narrative, which suppresses that mirroring tendency.
 * - See: https://github.com/moeru-ai/airi/issues/1539
 */
export function formatContextPromptText(contextsSnapshot: ContextSnapshot) {
  const entries = Object.entries(contextsSnapshot)
  if (entries.length === 0)
    return ''

  const lines = entries.flatMap(([contextId, messages]) =>
    messages.map(m => `- ${contextId}: ${m.text}`),
  )

  if (lines.length === 0)
    return ''

  return ['[Context]', ...lines].join('\n')
}

export function buildContextPromptMessage(contextsSnapshot: ContextSnapshot): UserMessage | null {
  const promptText = formatContextPromptText(contextsSnapshot)
  if (!promptText)
    return null

  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: promptText,
      },
    ],
  }
}

/**
 * Render available tools into explicit native tool-calling instructions.
 *
 * Use when:
 * - Composing a system prompt for providers that receive real tool schemas but
 *   still need plain-language guidance to choose and call those tools.
 * - Runtime tools such as MCP tools are registered dynamically.
 *
 * Expects:
 * - Tool names match the native tool schemas sent with the same request.
 * - Tool descriptions are already safe to expose to the model.
 *
 * Returns:
 * - Empty string when no callable tools are available.
 * - Otherwise a `[Tool Use]` block with concise rules and exact tool names.
 */
export function formatToolUsePromptText(tools: Tool[] | ToolPromptEntry[]) {
  const entries = tools
    .map((tool) => {
      if ('name' in tool)
        return tool

      return toolPromptEntryFromTool(tool)
    })
    .filter(entry => entry?.name) as ToolPromptEntry[]

  if (entries.length === 0)
    return ''

  const lines = entries.map((entry) => {
    const description = entry.description?.trim().replace(/\s+/g, ' ')
    if (!description)
      return `- ${entry.name}`

    return `- ${entry.name}: ${description}`
  })

  return [
    '[Tool Use]',
    '- The following names are real callable tool functions available in this request.',
    '- If the user asks to call or use one of them, call it immediately.',
    '- Do not describe, roleplay, or print a fake call. Use the function call channel.',
    '- Match by exact name, MCP server name, MCP tool name, or description.',
    '',
    'Callable tool functions:',
    ...lines,
  ].join('\n')
}
