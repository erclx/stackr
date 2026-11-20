import * as vscode from 'vscode'

import { StackProvider } from '../providers'
import { StackSortOrder } from '../services'
import { Command, CommandDependencies } from './types'

export function getFilterCommands(deps: CommandDependencies): Command[] {
  const toggleLogic = () => handleTogglePinned(deps.services.stackProvider)

  return [
    {
      id: 'aiContextStacker.showPinnedOnly',
      execute: toggleLogic,
    },
    {
      id: 'aiContextStacker.showAllFiles',
      execute: toggleLogic,
    },
    {
      id: 'aiContextStacker.sortByTokens',
      execute: () => handleSetSortOrder(deps.services.stackProvider, 'tokensDesc'),
    },
    {
      id: 'aiContextStacker.sortByName',
      execute: () => handleSetSortOrder(deps.services.stackProvider, 'name'),
    },
  ]
}

function handleTogglePinned(provider: StackProvider): void {
  const isPinnedOnly = provider.togglePinnedOnly()

  void vscode.commands.executeCommand('setContext', 'aiContextStacker.pinnedOnly', isPinnedOnly)

  if (isPinnedOnly) {
    void vscode.window.setStatusBarMessage('$(pin) AI Context: Showing Pinned Files Only', 3000)
  } else {
    void vscode.window.setStatusBarMessage('$(list-flat) AI Context: Showing All Files', 3000)
  }
}

async function handleSetSortOrder(provider: StackProvider, order: StackSortOrder): Promise<void> {
  provider.setSortOrder(order)

  const config = vscode.workspace.getConfiguration('aiContextStacker')
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global

  await config.update('sortOrder', order, target)

  if (order === 'tokensDesc') {
    void vscode.window.setStatusBarMessage('$(sort-precedence) Stackr: Sorted by Token Count (Highest First)', 3000)
  } else {
    void vscode.window.setStatusBarMessage('$(list-tree) Stackr: Sorted by Name', 3000)
  }
}
