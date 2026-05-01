import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isToolRelatedError, useLLM } from './llm'
import { useLlmToolsStore } from './llm-tools'

const {
  streamTextMock,
  mcpMock,
  debugMock,
  createSparkCommandToolMock,
} = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  mcpMock: vi.fn(async (): Promise<Tool[]> => []),
  debugMock: vi.fn(async (): Promise<Tool[]> => []),
  createSparkCommandToolMock: vi.fn(async (): Promise<unknown> => ({
    name: 'spark',
    description: '',
    parameters: {},
    execute: vi.fn(),
  })),
}))

vi.mock('@xsai/model', () => ({
  listModels: vi.fn(),
}))

vi.mock('@xsai/stream-text', () => ({
  streamText: streamTextMock,
}))

vi.mock('@xsai/shared-chat', () => ({
  or: vi.fn(),
  stepCountAtLeast: vi.fn(),
}))

vi.mock('../tools', () => ({
  mcp: mcpMock,
  debug: debugMock,
  createSparkCommandTool: createSparkCommandToolMock,
}))

const provider = {
  chat: () => ({
    baseURL: 'https://example.com/',
  }),
} as unknown as ChatProvider

function createMockStreamResult(events: unknown[] = []) {
  return {
    fullStream: new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(event)
        controller.close()
      },
    }),
    steps: Promise.resolve([]),
    messages: Promise.resolve([]),
    usage: Promise.resolve({}),
    totalUsage: Promise.resolve({}),
  }
}

function createControlledMockStreamResult() {
  let controller: ReadableStreamDefaultController<unknown> | undefined
  const fullStream = new ReadableStream({
    start(ctrl) {
      controller = ctrl
    },
  })

  return {
    close() {
      controller?.close()
    },
    push(event: unknown) {
      controller?.enqueue(event)
    },
    result: {
      fullStream,
      steps: Promise.resolve([]),
      messages: Promise.resolve([]),
      usage: Promise.resolve({}),
      totalUsage: Promise.resolve({}),
    },
  }
}

function toolNameFrom(tool: unknown) {
  if (typeof tool !== 'object' || tool === null)
    return undefined

  const candidate = tool as {
    name?: string
    function?: {
      name?: string
    }
  }

  return candidate.function?.name ?? candidate.name
}

describe('isToolRelatedError', () => {
  beforeEach(() => {
    streamTextMock.mockReset()
    mcpMock.mockClear()
    debugMock.mockClear()
    createSparkCommandToolMock.mockClear()
    setActivePinia(createPinia())
  })

  const positives: [provider: string, msg: string][] = [
    ['ollama', 'llama3 does not support tools'],
    ['ollama', 'phi does not support tools'],
    ['openrouter', 'No endpoints found that support tool use'],
    ['openai-compatible', 'Invalid schema for function \'myFunc\': \'dict\' is not valid under any of the given schemas'],
    ['openai-compatible', 'invalid_function_parameters'],
    ['openai-compatible', 'invalid function parameters'],
    ['azure', 'Functions are not supported at this time'],
    ['azure', 'Unrecognized request argument supplied: tools'],
    ['azure', 'Unrecognized request arguments supplied: tool_choice, tools'],
    ['google', 'Tool use with function calling is unsupported'],
    ['groq', 'tool_use_failed'],
    ['groq', 'Error code: tool_use_failed - Failed to call a function'],
    ['anthropic', 'This model does not support function calling'],
    ['anthropic', 'does not support function_calling'],
    ['cloudflare', 'tools is not supported'],
    ['cloudflare', 'tool is not supported for this model'],
    ['cloudflare', 'tools are not supported'],
  ]

  const negatives = [
    'network error',
    'timeout',
    'rate limit exceeded',
    'invalid api key',
    'model not found',
    'context length exceeded',
    '',
  ]

  for (const [provider, msg] of positives) {
    it(`matches [${provider}]: "${msg}"`, () => {
      expect(isToolRelatedError(msg)).toBe(true)
      expect(isToolRelatedError(new Error(msg))).toBe(true)
    })
  }

  for (const msg of negatives) {
    it(`rejects: "${msg}"`, () => {
      expect(isToolRelatedError(msg)).toBe(false)
      expect(isToolRelatedError(new Error(msg))).toBe(false)
    })
  }

  it('keeps stream pending on tool_calls finish when waitForTools is true', async () => {
    const stream = createControlledMockStreamResult()
    streamTextMock.mockImplementation(() => {
      return stream.result
    })

    const store = useLLM()
    const onStreamEvent = vi.fn()
    let resolved = false

    const pending = store.stream('model-a', provider, [{ role: 'user', content: 'hello' }] as Message[], {
      waitForTools: true,
      onStreamEvent,
    }).then(() => {
      resolved = true
    })

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1))
    stream.push({ type: 'finish', finishReason: 'tool_calls' })
    await Promise.resolve()
    expect(resolved).toBe(false)

    stream.push({ type: 'finish', finishReason: 'stop' })
    stream.close()
    await pending

    expect(onStreamEvent).toHaveBeenCalledTimes(2)
  })

  it('rejects stream on error event after waitForTools hold', async () => {
    const stream = createControlledMockStreamResult()
    streamTextMock.mockImplementation(() => {
      return stream.result
    })

    const store = useLLM()
    const pending = store.stream('model-a', provider, [{ role: 'user', content: 'hello' }] as Message[], {
      waitForTools: true,
    })

    await vi.waitFor(() => expect(streamTextMock).toHaveBeenCalledTimes(1))
    stream.push({ type: 'finish', finishReason: 'tool_calls' })
    stream.push({ type: 'error', error: new Error('stream failed') })
    stream.close()
    await expect(pending).rejects.toThrow('stream failed')
  })

  it('awaits async stream event handlers before resolving the turn', async () => {
    let releaseToolCall: (() => void) | undefined
    const toolCallReleased = new Promise<void>((resolve) => {
      releaseToolCall = resolve
    })
    const observedEvents: string[] = []

    streamTextMock.mockImplementation(() => {
      return createMockStreamResult([
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'status', args: '{}', toolCallType: 'function' },
        { type: 'tool-result', toolCallId: 'call-1', result: 'ok' },
        { type: 'finish', finishReason: 'stop' },
      ])
    })

    const store = useLLM()
    let resolved = false
    const pending = store.stream('model-a', provider, [{ role: 'user', content: 'status' }] as Message[], {
      waitForTools: true,
      onStreamEvent: async (event: any) => {
        observedEvents.push(event.type)
        if (event.type === 'tool-call')
          await toolCallReleased
      },
    }).then(() => {
      resolved = true
    })

    await vi.waitFor(() => expect(observedEvents).toEqual(['tool-call']))
    await Promise.resolve()
    expect(resolved).toBe(false)

    releaseToolCall?.()
    await pending

    expect(observedEvents).toEqual(['tool-call', 'tool-result', 'finish'])
    expect(resolved).toBe(true)
  })

  it('keeps builtin tools and auto-disables tools after tool-related errors', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const customTool = { name: 'custom-tool' } as any
    const runtimeTool = {
      function: {
        name: 'runtime_play_chess_match',
        description: 'Start a runtime chess match.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }

    llmToolsStore.registerTools('plugin-tools', [runtimeTool as any])

    streamTextMock.mockImplementationOnce(() => {
      return createMockStreamResult([{ type: 'error', error: new Error('model does not support tools') }])
    })

    await expect(store.stream('model-a', provider, [{ role: 'user', content: 'hello' }] as Message[], {
      tools: [customTool],
    })).rejects.toThrow('does not support tools')

    const firstCallTools = streamTextMock.mock.calls[0]?.[0]?.tools
    expect(Array.isArray(firstCallTools)).toBe(true)
    expect(debugMock).toHaveBeenCalledTimes(1)
    expect(firstCallTools).toContain(customTool)
    expect(firstCallTools?.map(toolNameFrom)).toContain('runtime_play_chess_match')

    streamTextMock.mockImplementationOnce(() => {
      return createMockStreamResult([{ type: 'finish', finishReason: 'stop' }])
    })

    await store.stream('model-a', provider, [{ role: 'user', content: 'hello again' }] as Message[], {
      tools: [customTool],
    })

    const secondCallTools = streamTextMock.mock.calls[1]?.[0]?.tools
    expect(secondCallTools).toBeUndefined()
  })

  it('merges runtime-registered tools from the llm-tools store into the builtin tool resolver', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const playChessTool = {
      function: {
        name: 'runtime_open_chess_board',
        description: 'Open the runtime chess board.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }
    const runtimeMcpStatusTool = {
      function: {
        name: 'runtime_sync_mcp_status',
        description: 'Sync runtime MCP status.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }

    llmToolsStore.registerTools('mcp', [runtimeMcpStatusTool as any])
    llmToolsStore.registerTools('plugin-tools', [playChessTool as any])

    streamTextMock.mockImplementationOnce(() => {
      return createMockStreamResult([{ type: 'finish', finishReason: 'stop' }])
    })

    await store.stream('model-a', provider, [{ role: 'user', content: 'play chess' }] as Message[])

    const mergedTools = streamTextMock.mock.calls[0]?.[0]?.tools
    expect(mergedTools).toEqual(expect.arrayContaining([runtimeMcpStatusTool, playChessTool]))
  })

  it('injects explicit native tool-use instructions into the request system prompt', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const runtimeMcpStatusTool = {
      function: {
        name: 'runtime_sync_mcp_status',
        description: 'Sync runtime MCP status.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }
    const messages = [
      { role: 'system', content: 'character prompt' },
      { role: 'user', content: 'sync mcp status' },
    ] as Message[]

    llmToolsStore.registerTools('mcp', [runtimeMcpStatusTool as any])

    streamTextMock.mockImplementationOnce(() => {
      return createMockStreamResult([{ type: 'finish', finishReason: 'stop' }])
    })

    await store.stream('model-a', provider, messages)

    const sentMessages = streamTextMock.mock.calls[0]?.[0]?.messages as Message[]
    expect(sentMessages[0]).toMatchObject({ role: 'system' })
    expect(sentMessages[0]?.content).toContain('character prompt')
    expect(sentMessages[0]?.content).toContain('[Tool Use]')
    expect(sentMessages[0]?.content).toContain('real callable tool functions')
    expect(sentMessages[0]?.content).toContain('Do not describe, roleplay, or print a fake call')
    expect(sentMessages[0]?.content).toContain('- runtime_sync_mcp_status: Sync runtime MCP status.')
    expect(messages[0]?.content).toBe('character prompt')
  })

  it('keeps non-MCP runtime tools out of the injected prompt', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const runtimeMcpStatusTool = {
      function: {
        name: 'runtime_sync_mcp_status',
        description: 'Sync runtime MCP status.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }
    const playChessTool = {
      function: {
        name: 'runtime_open_chess_board',
        description: 'Open the runtime chess board.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }

    llmToolsStore.registerTools('mcp', [runtimeMcpStatusTool as any])
    llmToolsStore.registerTools('plugin-tools', [playChessTool as any])

    streamTextMock.mockImplementationOnce(() => {
      return createMockStreamResult([{ type: 'finish', finishReason: 'stop' }])
    })

    await store.stream('model-a', provider, [{ role: 'user', content: 'sync mcp status' }] as Message[])

    const sentMessages = streamTextMock.mock.calls[0]?.[0]?.messages as Message[]
    const systemContent = sentMessages[0]?.content as string
    expect(systemContent).toContain('- runtime_sync_mcp_status: Sync runtime MCP status.')
    expect(systemContent).not.toContain('runtime_open_chess_board')
  })

  it('prefers runtime-registered tools when duplicate tool names collide with builtin tools', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const builtinTool = {
      function: {
        name: 'duplicate_runtime_tool',
        description: 'Builtin version.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    } as unknown as Tool
    const runtimeTool = {
      function: {
        name: 'duplicate_runtime_tool',
        description: 'Runtime version.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }

    mcpMock.mockResolvedValueOnce([builtinTool] as Tool[])
    llmToolsStore.registerTools('plugin-tools', [runtimeTool as any])

    streamTextMock.mockImplementationOnce(() => {
      return createMockStreamResult([{ type: 'finish', finishReason: 'stop' }])
    })

    await store.stream('model-a', provider, [{ role: 'user', content: 'play chess' }] as Message[])

    const mergedTools = streamTextMock.mock.calls[0]?.[0]?.tools as Array<{ function?: { name?: string } }>
    const duplicateNameTools = mergedTools.filter(tool => tool.function?.name === 'duplicate_runtime_tool')

    expect(duplicateNameTools).toHaveLength(1)
    expect(duplicateNameTools[0]).toMatchObject({
      function: {
        name: 'duplicate_runtime_tool',
        description: 'Runtime version.',
      },
    })
  })

  /**
   * @example
   * llmToolsStore.registerTools('plugin-tools', pendingRuntimeTools)
   * await store.stream('model-a', provider, messages)
   */
  it('waits for pending runtime tool registrations before building stream tools', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const runtimeTool = {
      function: {
        name: 'runtime_pending_tool',
        description: 'Pending runtime tool.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    }
    let resolveTools: ((tools: unknown[]) => void) | undefined
    const pendingTools = new Promise<unknown[]>((resolve) => {
      resolveTools = resolve
    })

    llmToolsStore.registerTools('plugin-tools', pendingTools as Promise<any[]>)

    streamTextMock.mockImplementationOnce(() => {
      return createMockStreamResult([{ type: 'finish', finishReason: 'stop' }])
    })

    const pendingStream = store.stream('model-a', provider, [{ role: 'user', content: 'play chess' }] as Message[])
    await Promise.resolve()

    expect(streamTextMock).not.toHaveBeenCalled()

    resolveTools?.([runtimeTool])
    await pendingStream

    const mergedTools = streamTextMock.mock.calls[0]?.[0]?.tools
    expect(mergedTools?.map(toolNameFrom)).toContain('runtime_pending_tool')
  })
})
