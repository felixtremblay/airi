import type { JsonSchema } from 'xsschema'

import { describe, expect, it, vi } from 'vitest'

import { createFlatMcpTools, flatMcpToolName } from './mcp'

describe('flatMcpToolName', () => {
  /**
   * @example
   * flatMcpToolName({ serverName: 'duckduckgo', toolName: 'search' })
   * // => 'search'
   */
  it('uses just the tool name when not qualified', () => {
    expect(flatMcpToolName({ serverName: 'duckduckgo', toolName: 'search' })).toBe('search')
  })

  /**
   * @example
   * flatMcpToolName({ serverName: 'duckduckgo', toolName: 'search' }, true)
   * // => 'duckduckgo__search'
   */
  it('joins server and tool with a double-underscore when qualified', () => {
    expect(flatMcpToolName({ serverName: 'duckduckgo', toolName: 'search' }, true)).toBe('duckduckgo__search')
  })

  /**
   * @example
   * flatMcpToolName({ serverName: 'svc.weird/name', toolName: 'do:thing' }, true)
   * // => 'svc_weird_name__do_thing'
   */
  it('replaces characters that violate the OpenAI tool name regex', () => {
    expect(flatMcpToolName({ serverName: 'svc.weird/name', toolName: 'do:thing' }, true)).toBe('svc_weird_name__do_thing')
  })
})

describe('createFlatMcpTools', () => {
  /**
   * @example
   * const tools = await createFlatMcpTools(runtime)
   * await tools[0].execute({ query: 'hello' }, options)
   */
  it('uses bare tool names when collision-free and forwards calls via runtime.callTool with the original qualified name', async () => {
    const runtime = {
      listTools: vi.fn(async () => [
        {
          serverName: 'duckduckgo',
          name: 'duckduckgo::search',
          toolName: 'search',
          description: 'Web search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ]),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      })),
    }

    const tools = await createFlatMcpTools(runtime)

    expect(tools).toHaveLength(1)
    const flat = tools[0]
    expect(flat.function.name).toBe('search')
    expect(flat.function.description).toBe('MCP server: duckduckgo; MCP tool: search. Web search')
    expect(flat.function.strict).toBe(false)
    expect((flat.function.parameters as JsonSchema).type).toBe('object')

    const result = await flat.execute({ query: 'hello' }, {} as Parameters<typeof flat.execute>[1])

    expect(runtime.callTool).toHaveBeenCalledWith({
      name: 'duckduckgo::search',
      arguments: { query: 'hello' },
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
  })

  /**
   * @example
   * // duckduckgo and brave both expose `search`
   * const tools = await createFlatMcpTools(runtime)
   * expect(tools.map(t => t.function.name)).toEqual(['duckduckgo__search', 'brave__search'])
   */
  it('falls back to qualified <server>__<tool> names only when two servers share a tool name', async () => {
    const runtime = {
      listTools: vi.fn(async () => [
        {
          serverName: 'duckduckgo',
          name: 'duckduckgo::search',
          toolName: 'search',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          serverName: 'brave',
          name: 'brave::search',
          toolName: 'search',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          serverName: 'handy',
          name: 'handy::play_pattern',
          toolName: 'play_pattern',
          inputSchema: { type: 'object', properties: {} },
        },
      ]),
      callTool: vi.fn(async () => ({})),
    }

    const tools = await createFlatMcpTools(runtime)

    expect(tools.map(t => t.function.name)).toEqual([
      'duckduckgo__search',
      'brave__search',
      'play_pattern',
    ])
  })

  /**
   * @example
   * const tools = await createFlatMcpTools({ listTools: throws, callTool: noop })
   * expect(tools).toEqual([])
   */
  it('returns an empty list when the runtime cannot list tools', async () => {
    const runtime = {
      listTools: vi.fn(async () => {
        throw new Error('runtime offline')
      }),
      callTool: vi.fn(),
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const tools = await createFlatMcpTools(runtime)

    expect(tools).toEqual([])
    expect(runtime.callTool).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  /**
   * @example
   * descriptor.inputSchema = {} // server forgot the type field
   * const tools = await createFlatMcpTools(runtime)
   * expect(tools[0].function.parameters.type).toBe('object')
   */
  it('coerces a missing top-level schema type to "object" so OpenAI accepts the tool', async () => {
    const runtime = {
      listTools: vi.fn(async () => [
        {
          serverName: 'svc',
          name: 'svc::ping',
          toolName: 'ping',
          inputSchema: {} as Record<string, unknown>,
        },
      ]),
      callTool: vi.fn(async () => ({})),
    }

    const tools = await createFlatMcpTools(runtime)
    expect((tools[0].function.parameters as JsonSchema).type).toBe('object')
  })
})
