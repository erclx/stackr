import * as vscode from 'vscode'

import { Logger } from '../utils'
import { Command, CommandDependencies } from './types'

export function getOpenSettingsCommands(_deps: CommandDependencies): Command[] {
  return [
    {
      id: 'aiContextStacker.openSettings',
      execute: async () => {
        try {
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:erclx.ai-context-stacker')
        } catch (error) {
          Logger.error('Failed to open settings UI', error)
        }
      },
    },
    {
      id: 'aiContextStacker.toggleTokenEstimation',
      execute: async () => {
        const config = vscode.workspace.getConfiguration('aiContextStacker')
        const current = config.get<boolean>('enableTokenEstimation', true)
        const next = !current
        const target = vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global

        await config.update('enableTokenEstimation', next, target)
        void vscode.window.showInformationMessage(
          next ? 'Stackr: Token estimation enabled.' : 'Stackr: Token estimation disabled (Context Map mode).',
        )
      },
    },
  ]
}
