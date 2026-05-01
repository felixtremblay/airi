import type { Tool } from '@xsai/shared-chat'
import type { JsonSchema } from 'xsschema'

import { errorMessageFrom } from '@moeru/std'
import { rawTool } from '@xsai/tool'

/**
 * Describes an MCP tool that can be exposed to the shared LLM runtime.
 *
 * Use when:
 * - A runtime needs to list available MCP tools before exposing them to models
 *
 * Expects:
 * - `name` is the fully-qualified tool name used for invocation (`serverName::toolName`)
 *
 * Returns:
 * - The MCP tool descriptor metadata reported by the runtime
 */
export interface McpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * Payload for invoking an MCP tool through a runtime-specific transport.
 *
 * Use when:
 * - A runtime needs to forward a tool invocation into the MCP layer
 *
 * Expects:
 * - `name` matches a descriptor returned from `listTools` (qualified `serverName::toolName`)
 * - `arguments` is a JSON-compatible object when provided
 *
 * Returns:
 * - The MCP tool call input envelope
 */
export interface McpCallToolPayload {
  name: string
  arguments?: Record<string, unknown>
}

/**
 * Result returned from an MCP tool invocation.
 *
 * Use when:
 * - An MCP runtime returns tool output back to the shared LLM layer
 *
 * Expects:
 * - Error responses set `isError` when the tool execution failed
 *
 * Returns:
 * - Structured and unstructured MCP tool output
 */
export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
}

/**
 * Runtime contract for wiring MCP tool discovery and execution into `stage-ui`.
 *
 * Use when:
 * - A concrete runtime such as Electron needs to provide MCP access without a singleton bridge
 *
 * Expects:
 * - `listTools` and `callTool` are safe to call multiple times
 *
 * Returns:
 * - An object that can back `createFlatMcpTools`
 */
export interface McpToolRuntime {
  listTools: () => Promise<McpToolDescriptor[]>
  callTool: (payload: McpCallToolPayload) => Promise<McpCallToolResult>
}

const flatToolNameSeparator = '__'
const flatToolNameMaxLength = 64

/**
 * Normalizes an MCP segment (server or tool) into characters accepted by
 * OpenAI-style tool names.
 *
 * Before:
 * - "duckduckgo::search"
 *
 * After:
 * - "duckduckgo__search"
 */
function sanitizeNameSegment(segment: string): string {
  return segment.replace(/[^\w-]/g, '_')
}

/**
 * Builds a flat tool name from an MCP descriptor.
 *
 * When `qualified` is `false` (the default for collision-free names), only the
 * tool's own name is used — this preserves any references to that tool name in
 * the description prose (e.g. handy-mcp's `play_pattern` description that
 * references `oscillate` and `set_range`). When two or more servers expose the
 * same tool name, the qualified `<server>__<tool>` form is required to
 * disambiguate.
 *
 * Before:
 * - { serverName: "duckduckgo", toolName: "search" }, qualified=false
 *
 * After:
 * - "search"
 *
 * Before:
 * - { serverName: "duckduckgo", toolName: "search" }, qualified=true
 *
 * After:
 * - "duckduckgo__search"
 */
export function flatMcpToolName(descriptor: Pick<McpToolDescriptor, 'serverName' | 'toolName'>, qualified = false): string {
  const joined = qualified
    ? `${sanitizeNameSegment(descriptor.serverName)}${flatToolNameSeparator}${sanitizeNameSegment(descriptor.toolName)}`
    : sanitizeNameSegment(descriptor.toolName)
  return joined.slice(0, flatToolNameMaxLength)
}

/**
 * Coerces an MCP `inputSchema` into a JSON Schema object the LLM provider will accept.
 *
 * Use when:
 * - Flattening MCP tool descriptors into xsai `Tool` definitions
 *
 * Expects:
 * - `schema` originates from an MCP server's `tools/list` response
 *
 * Returns:
 * - A JSON Schema object with at least `type: 'object'` so providers do not reject it
 */
function normalizeMcpInputSchema(schema: Record<string, unknown> | undefined): JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, additionalProperties: true }
  }

  // NOTICE:
  // Some MCP servers omit the top-level `type` field. OpenAI rejects function
  // parameter schemas without an explicit object type, so default to `object`
  // when missing while leaving everything else untouched.
  // Source: openai api error "Invalid schema for function ... 'type' is required"
  // Removal condition: when MCP servers reliably emit a top-level `type`.
  if (typeof schema.type !== 'string') {
    return { type: 'object', ...schema } as JsonSchema
  }

  return schema as JsonSchema
}

function formatMcpToolDescription(descriptor: McpToolDescriptor): string {
  const source = `MCP server: ${descriptor.serverName}; MCP tool: ${descriptor.toolName}.`
  if (!descriptor.description?.trim())
    return source

  return `${source} ${descriptor.description.trim()}`
}

/**
 * Creates a flat list of xsai tools, one per MCP descriptor returned by the runtime.
 *
 * Use when:
 * - A runtime wants the LLM to see real MCP tools at the top level instead of
 *   the legacy `mcpListTools`/`mcpCallTool` proxy pair
 *
 * Expects:
 * - The runtime exposes both discovery (`listTools`) and execution (`callTool`)
 *
 * Returns:
 * - One xsai `Tool` per discovered MCP tool, named `<server>__<tool>`, executing
 *   straight through `runtime.callTool` with the original qualified name so the
 *   main-process router (`parseQualifiedToolName`) can still resolve it
 */
export async function createFlatMcpTools(runtime: McpToolRuntime): Promise<Tool[]> {
  let descriptors: McpToolDescriptor[] = []
  try {
    descriptors = await runtime.listTools()
  }
  catch (error) {
    console.warn('[createFlatMcpTools] failed to list tools:', error)
    return []
  }

  // Count tool-name occurrences across all servers so we only fall back to the
  // qualified `<server>__<tool>` form when a name actually collides between
  // servers. Models invoke tools by name, and tool descriptions written by MCP
  // servers tend to reference sibling tools by their bare name (e.g. handy-mcp's
  // `play_pattern` description mentions `oscillate` and `set_range`). Always
  // prefixing breaks that intra-description link and confuses smaller models
  // into emitting prose instead of structured tool calls.
  const toolNameCounts = new Map<string, number>()
  for (const descriptor of descriptors) {
    toolNameCounts.set(descriptor.toolName, (toolNameCounts.get(descriptor.toolName) ?? 0) + 1)
  }

  return descriptors.map((descriptor) => {
    const qualifiedName = descriptor.name
    const collides = (toolNameCounts.get(descriptor.toolName) ?? 0) > 1
    return rawTool<Record<string, unknown>>({
      name: flatMcpToolName(descriptor, collides),
      description: formatMcpToolDescription(descriptor),
      parameters: normalizeMcpInputSchema(descriptor.inputSchema),
      // NOTICE:
      // strict mode forces every property to appear in `required`. MCP server
      // schemas frequently violate that, so disable strict to avoid wholesale
      // tool rejection by OpenAI-compatible providers.
      // Source: openai docs on structured outputs / strict function calling.
      // Removal condition: when MCP schemas can be reliably normalized to strict.
      strict: false,
      execute: async (input) => {
        const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
        try {
          return await runtime.callTool({ name: qualifiedName, arguments: args })
        }
        catch (error) {
          // NOTICE:
          // xsai's runTool wraps any throw in a generic `ToolExecutionError`
          // ("Tool ... execution failed.") and only the outer message reaches
          // the chat UI. Convert the cause into an MCP-style isError result so
          // both the model and the UI see the actual failure reason instead of
          // a useless wrapper string.
          // Source: @xsai/shared-chat dist/index.js runTool, ~line 51-67.
          // Removal condition: when xsai surfaces tool-call causes verbatim.
          const message = errorMessageFrom(error) ?? String(error)
          console.error(`[mcp:${qualifiedName}] callTool threw:`, error)
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          }
        }
      },
    })
  })
}
