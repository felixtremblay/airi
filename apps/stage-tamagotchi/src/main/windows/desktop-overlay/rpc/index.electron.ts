/**
 * Desktop Overlay Window — Electron RPC bootstrap
 *
 * Minimal eventa context setup for the overlay BrowserWindow. Registers base
 * window services. MCP tool services (`callTool`/`listTools`) used by the
 * overlay's `computer_use::desktop_get_state` polling are registered globally
 * in `apps/stage-tamagotchi/src/main/index.ts`, not per-window — see the
 * NOTICE in that file for why.
 */

import type { BrowserWindow } from 'electron'

import type { I18n } from '../../../libs/i18n'
import type { ServerChannel } from '../../../services/airi/channel-server'
import type { DesktopOverlayReadiness } from './contracts'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { ipcMain } from 'electron'

import { getDesktopOverlayReadinessContract } from '../../../../shared/eventa'
import { setupBaseWindowElectronInvokes } from '../../shared/window'

export async function setupDesktopOverlayElectronInvokes(params: {
  window: BrowserWindow
  serverChannel: ServerChannel
  i18n: I18n
}) {
  // TODO: once we refactored eventa to support window-namespaced contexts,
  // we can remove the setMaxListeners call below since eventa will be able to dispatch and
  // manage events within eventa's context system.
  ipcMain.setMaxListeners(0)

  const { context } = createContext(ipcMain, params.window)

  let readiness: DesktopOverlayReadiness = { state: 'booting' }

  defineInvokeHandler(context, getDesktopOverlayReadinessContract, async () => {
    return readiness
  })

  try {
    await setupBaseWindowElectronInvokes({ context, window: params.window, i18n: params.i18n, serverChannel: params.serverChannel })
    readiness = { state: 'ready' }
  }
  catch (error) {
    readiness = {
      state: 'degraded',
      error: error instanceof Error ? error.message : String(error),
    }
    // We intentionally don't throw here so the window still opens and
    // the renderer gracefully detects the degraded state via polling.
  }
}
