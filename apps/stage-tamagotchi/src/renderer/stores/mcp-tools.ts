import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { createFlatMcpTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpListTools } from '../../shared/eventa'

/**
 * Registers Electron-backed MCP tools into the shared LLM tools store as
 * flat, top-level tools (one per MCP server tool) so the model can see them
 * directly without a discovery round-trip.
 *
 * Use when:
 * - The Tamagotchi renderer needs live MCP tools during chat streaming
 *
 * Expects:
 * - Electron Eventa handlers for MCP listing and invocation are available
 *
 * Returns:
 * - Store actions for refreshing and disposing MCP runtime tools
 */
export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)

  async function refresh() {
    return llmToolsStore.registerTools('mcp', createFlatMcpTools({
      listTools: () => listMcpTools(),
      callTool: payload => callMcpTool(payload),
    }))
  }

  function dispose() {
    llmToolsStore.clearTools('mcp')
  }

  return {
    dispose,
    refresh,
  }
})
